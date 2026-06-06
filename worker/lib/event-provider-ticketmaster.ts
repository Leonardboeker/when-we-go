// worker/lib/event-provider-ticketmaster.ts
// REAL, dated events for the trip window via the Ticketmaster Discovery API.
// Companion to the keyless WikimediaActivityProvider: Wikipedia supplies the
// evergreen `alwaysGreat` sights, this supplies the date-bound `thisWeek`
// concerts/festivals/shows that actually happen while the group is there.
//
// Why a standalone function (not an ActivityProvider impl): the provider
// abstraction returns the WHOLE ActivityList for a destination string, but we
// only want the `thisWeek` slice and we already have resolved lat/lng + the
// exact trip date range from the handler. So activities.ts calls this directly
// and merges the result into the bucket. Mirrors how weather.ts is a plain
// fetch helper rather than a provider.
//
// CRITICAL — query by latlong+radius, NOT city=. Ticketmaster's `city=` filter
// is unreliable for non-US metros (city=Copenhagen returns 0 results), while a
// geo radius search returns the real local listings (hundreds for Copenhagen in
// summer). We always have coords here, so this is never a problem.
//
// Auth: env.WHENWEGO_TICKETMASTER_API_KEY (a Worker secret). When it's unset
// the whole feature is silently off — fetchTicketmasterEvents returns [] so the
// page still renders (alwaysGreat from Wikimedia carries it). Same graceful-off
// shape as the VAPID / Amadeus paths.
//
// Failure policy: NEVER throws. Any network/HTTP/parse error → return []. A
// flaky third-party API must not break the trip page; the events section just
// stays empty in that case.

import type { Env } from '../durable-object';
import type { ActivityItem, ActivityType } from './activity-provider.ts';

const DISCOVERY_ENDPOINT =
  'https://app.ticketmaster.com/discovery/v2/events.json';
const REQUEST_TIMEOUT_MS = 8000;
/** Geo radius around the destination centre. */
const RADIUS_KM = 30;
/** How many raw events to pull before dedup/cap (TM lists many ticket variants). */
const PAGE_SIZE = 30;
/** Final cap on returned events after dedup. */
const MAX_EVENTS = 8;

// ─── Discovery response shapes (only the fields we read) ──────────────────────

interface TmImage {
  url?: string;
  width?: number;
  height?: number;
  ratio?: string;
}
interface TmVenueLocation {
  latitude?: string;
  longitude?: string;
}
interface TmVenueCity {
  name?: string;
}
interface TmVenue {
  name?: string;
  city?: TmVenueCity;
  location?: TmVenueLocation;
}
interface TmClassificationSegment {
  name?: string;
}
interface TmClassification {
  segment?: TmClassificationSegment;
}
interface TmEventDateStart {
  localDate?: string;
  localTime?: string;
}
interface TmEvent {
  name?: string;
  url?: string;
  dates?: { start?: TmEventDateStart };
  images?: TmImage[];
  classifications?: TmClassification[];
  _embedded?: { venues?: TmVenue[] };
}
export interface TicketmasterDiscoveryResponse {
  _embedded?: { events?: TmEvent[] };
  page?: { totalElements?: number };
}

// ─── German date formatting ───────────────────────────────────────────────────

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * "2026-07-09" → "9. Juli". Returns the raw string if it doesn't parse so we
 * never render an empty/garbage date.
 */
function formatGermanDate(localDate: string): string {
  const parts = localDate.split('-');
  if (parts.length !== 3) return localDate;
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return localDate;
  const monthName = MONTHS_DE[month - 1];
  if (!monthName) return localDate;
  return `${day}. ${monthName}`;
}

/** "18:00:00" → "18:00"; empty/invalid → ''. */
function formatTime(localTime: string | undefined): string {
  if (!localTime) return '';
  const hhmm = localTime.slice(0, 5);
  return /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '';
}

// ─── classification → ActivityType ────────────────────────────────────────────

/**
 * Map the Discovery `segment` to our coarse ActivityType so the UI picks the
 * right icon. Everything falls back to 'event' (these are all dated events).
 */
function classifyEvent(segmentName: string | undefined): ActivityType {
  const seg = (segmentName ?? '').toLowerCase();
  if (seg.includes('music')) return 'concert';
  if (seg.includes('arts') || seg.includes('theatre') || seg.includes('theater'))
    return 'event';
  // Sports / Film / Miscellaneous etc. — still a dated thing to do.
  return 'event';
}

// ─── image picking ────────────────────────────────────────────────────────────

/**
 * Pick the best card photo: prefer a 16_9 image at >=600px wide (matches the
 * card's landscape crop), else the widest available, else the first. Returns
 * undefined when the event carries no usable image.
 */
function pickImage(images: TmImage[] | undefined): string | undefined {
  if (!images || images.length === 0) return undefined;
  const withUrl = images.filter((i) => typeof i.url === 'string' && i.url);
  if (withUrl.length === 0) return undefined;

  const wide = withUrl.find(
    (i) => i.ratio === '16_9' && typeof i.width === 'number' && i.width >= 600
  );
  if (wide?.url) return wide.url;

  // Widest by pixel width as a fallback (good crops are usually the big ones).
  const byWidth = [...withUrl].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0)
  );
  return byWidth[0]?.url ?? withUrl[0]?.url;
}

// ─── parse one event → ActivityItem | null ────────────────────────────────────

function mapsUrlFor(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/**
 * Convert a single Discovery event to an ActivityItem. Returns null when the
 * event lacks the essentials (name + ticket url + a parsable date). Coordinates
 * are optional — without them the item simply won't appear on the Leaflet map,
 * but still renders as a card.
 *
 * Exported for unit testing the parser against a fixture (no live API needed).
 */
export function eventToActivityItem(ev: TmEvent): ActivityItem | null {
  const name = (ev.name ?? '').trim();
  const link = (ev.url ?? '').trim(); // the ticket link
  const localDate = ev.dates?.start?.localDate;
  if (!name || !link || !localDate) return null;

  const venue = ev._embedded?.venues?.[0];
  const venueName = venue?.name?.trim() ?? '';
  const venueCity = venue?.city?.name?.trim() ?? '';

  // Coordinates arrive as strings; coerce + validate.
  let lat: number | undefined;
  let lng: number | undefined;
  const rawLat = venue?.location?.latitude;
  const rawLng = venue?.location?.longitude;
  if (typeof rawLat === 'string' && typeof rawLng === 'string') {
    const pLat = parseFloat(rawLat);
    const pLng = parseFloat(rawLng);
    if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
      lat = pLat;
      lng = pLng;
    }
  }

  const segmentName = ev.classifications?.[0]?.segment?.name;
  const type = classifyEvent(segmentName);

  // German description: "9. Juli · 18:00 · Royal Arena, Copenhagen".
  const germanDate = formatGermanDate(localDate);
  const time = formatTime(ev.dates?.start?.localTime);
  const placeParts = [venueName, venueCity].filter(Boolean);
  const place = placeParts.join(', ');
  const descParts = [germanDate];
  if (time) descParts.push(time);
  if (place) descParts.push(place);
  const description = descParts.join(' · ');

  const item: ActivityItem = {
    name: name.slice(0, 80),
    type,
    // dateRange carries the human date so the existing card meta line shows it.
    dateRange: germanDate,
    paid: true, // ticketed events always cost money
    priceEur: null, // Discovery price ranges are unreliable across markets — omit.
    whyOneSentence: description.slice(0, 160),
    confidence: 'high', // real, dated, with a ticket link — verifiable
    source: 'ticketmaster',
    link, // ticket link → UI renders "Tickets →"
    photoUrl: pickImage(ev.images),
    mapsUrl:
      lat !== undefined && lng !== undefined ? mapsUrlFor(lat, lng) : undefined,
    lat,
    lng,
  };
  return item;
}

// ─── dedup ────────────────────────────────────────────────────────────────────

/**
 * Ticketmaster lists the same event many times (one row per ticket type:
 * "… - Full", "… - VIP", "… - Day 1"). Collapse by a normalized name so the
 * list reads like distinct events. Normalization: lowercase, strip a trailing
 * " - <variant>" suffix, collapse whitespace.
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*[-–—]\s*[^-–—]*$/, '') // drop a trailing " - VIP" / " – Day 2"
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupByName(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const item of items) {
    const key = normalizeName(item.name) || item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ─── parse a full Discovery response → deduped, sorted, capped items ──────────

/**
 * Pure transform: Discovery JSON → ActivityItem[] (deduped by name, sorted by
 * date asc, capped at MAX_EVENTS). Exported so it can be unit-tested against a
 * hardcoded sample with no network. Date sort uses the raw localDate+localTime
 * ISO-ish string which sorts lexicographically for YYYY-MM-DD.
 */
export function parseDiscoveryResponse(
  body: TicketmasterDiscoveryResponse
): ActivityItem[] {
  const events = body?._embedded?.events ?? [];
  // Carry the raw sort key alongside the mapped item (the item drops localTime).
  const mapped: Array<{ item: ActivityItem; sortKey: string }> = [];
  for (const ev of events) {
    const item = eventToActivityItem(ev);
    if (!item) continue;
    const d = ev.dates?.start?.localDate ?? '';
    const t = ev.dates?.start?.localTime ?? '00:00:00';
    mapped.push({ item, sortKey: `${d}T${t}` });
  }
  // Dedup FIRST, in the API's original order. Ticketmaster returns the canonical
  // listing for an event before its ticket-type variants, so first-wins keeps
  // the richest record (proper start time + best image) rather than a later
  // "- VIP"/"- Day 2" row. THEN sort the survivors by date asc. (Sorting before
  // dedup would let a midnight-defaulted variant outrank the timed original.)
  const deduped = dedupByName(mapped.map((m) => m.item));
  const keys = new Set(deduped);
  const survivors = mapped.filter((m) => keys.has(m.item));
  survivors.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return survivors.map((m) => m.item).slice(0, MAX_EVENTS);
}

// ─── public entrypoint ────────────────────────────────────────────────────────

/**
 * Fetch dated events near (lat,lng) within [startDateIso, endDateIso] (each an
 * ISO YYYY-MM-DD). Returns [] on missing key / any error (graceful off).
 *
 * @param env           Worker env — reads WHENWEGO_TICKETMASTER_API_KEY.
 * @param lat           Destination centre latitude (WGS84).
 * @param lng           Destination centre longitude (WGS84).
 * @param startDateIso  Trip start, YYYY-MM-DD inclusive.
 * @param endDateIso    Trip end, YYYY-MM-DD inclusive.
 */
export async function fetchTicketmasterEvents(
  env: Env,
  lat: number,
  lng: number,
  startDateIso: string,
  endDateIso: string
): Promise<ActivityItem[]> {
  const apiKey = env.WHENWEGO_TICKETMASTER_API_KEY;
  if (!apiKey) {
    // Graceful off — the secret isn't configured. No log spam; this is expected
    // in local dev / when the feature isn't enabled for an environment.
    return [];
  }
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !startDateIso ||
    !endDateIso
  ) {
    return [];
  }

  const params = new URLSearchParams({
    apikey: apiKey,
    latlong: `${lat},${lng}`,
    radius: String(RADIUS_KM),
    unit: 'km',
    startDateTime: `${startDateIso}T00:00:00Z`,
    endDateTime: `${endDateIso}T23:59:59Z`,
    sort: 'date,asc',
    size: String(PAGE_SIZE),
  });

  let res: Response;
  try {
    res = await fetch(`${DISCOVERY_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.log(
      `[ticketmaster] fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }

  if (!res.ok) {
    console.log(`[ticketmaster] HTTP ${res.status}`);
    return [];
  }

  let body: TicketmasterDiscoveryResponse;
  try {
    body = (await res.json()) as TicketmasterDiscoveryResponse;
  } catch (err) {
    console.log(
      `[ticketmaster] JSON parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }

  try {
    return parseDiscoveryResponse(body);
  } catch (err) {
    // Defensive: a shape we didn't anticipate must not break the page.
    console.log(
      `[ticketmaster] parse error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}
