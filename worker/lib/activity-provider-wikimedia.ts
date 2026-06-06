// worker/lib/activity-provider-wikimedia.ts
// REAL, keyless activity provider backed entirely by Wikimedia + Openverse —
// no API key, no credit card. Mirrors the keyless KiwiPublicFlightProvider on
// the flights side (the default real provider when no secret is configured).
//
// Pipeline (all keyless GETs against public endpoints):
//   1. Resolve the destination string ("Copenhagen, Denmark") to lat/lng.
//      Fast path = the hand-curated destinations-geo.json table (shared with
//      weather.ts); fallback = Open-Meteo's keyless geocoding API.
//   2. Candidate POIs via the MediaWiki *relevance-ranked* geo search
//      (generator=search & gsrsearch=nearcoord:…) on Wikipedia. Plain
//      generator=geosearch sorts purely by distance, which in dense European
//      city centres drowns the famous attractions under hundreds of minor
//      geotagged buildings/streets — nearcoord ranks by article relevance so
//      Tivoli / Little Mermaid / Rosenborg actually surface. One call returns
//      coordinates + a lead photo (pageimages thumbnail) + a short description.
//      colimit=max is REQUIRED — the coordinates module defaults to 10 results
//      per query and silently drops the rest otherwise.
//   3. Filter to real attractions: must carry a thumbnail + description +
//      coordinates; drop obvious non-attractions (battles, companies, streets,
//      stations, schools…); prefer attraction-y titles/descriptions.
//   4. Re-rank by real prominence using the keyless PageViewInfo extension
//      (prop=pageviews, batched), so the list reads like a "top sights" list.
//   5. Per POI: Wikipedia article URL as the primary "ansehen" link + a Google
//      Maps link from the coordinates. If a POI somehow lacks a thumbnail we
//      fall back to Openverse (fully keyless CC image search) and carry the
//      licence/attribution.
//
// OPTIONAL: if an OpenTripMap key is provided we *could* use its categorised+
// rated POIs as a primary list, but the default path is Wikipedia-only and is
// what runs without any secret (see getActivityProvider).
//
// Everything returned is real: real coordinates, real Wikimedia Commons photos,
// real Wikipedia links. Nothing fabricated. These are evergreen sights, so they
// all land in `alwaysGreat` (thisWeek stays empty — we have no date signal).
//
// Failure policy: a hard failure (network / HTTP / no candidates at all) THROWS
// so activities.ts's fetchActivities() wrapper downgrades to
// reason:'provider_error' and the handler serves stale cache / mock.

import type {
  ActivityItem,
  ActivityList,
  ActivityProvider,
  ActivitySearchInput,
  ActivitySearchResult,
  ActivityType,
} from './activity-provider.ts';
import { resolveDestinationGeo } from './weather.ts';

// ─── tuning ──────────────────────────────────────────────────────────────────

const WIKI_LANG = 'en';
const WIKI_API = `https://${WIKI_LANG}.wikipedia.org/w/api.php`;
const OPENVERSE_API = 'https://api.openverse.org/v1/images/';
const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';

/** Descriptive UA — Wikimedia throttles/blocks anonymous keyless traffic. */
const USER_AGENT = 'when-we-go/1.0 (+https://when-we-go-demo.pages.dev)';
const REQUEST_TIMEOUT_MS = 8000;

/** Search radius for nearcoord (km). */
const SEARCH_RADIUS_KM = 10;
/** How many relevance-ranked candidates to pull before filtering. */
const CANDIDATE_LIMIT = 50;
/** Thumbnail width requested from pageimages. */
const THUMB_PX = 600;
/** Days of pageview history to sum for the prominence ranking. */
const PAGEVIEW_DAYS = 20;
/** Final cap on returned attractions. */
const MAX_RESULTS = 12;
/** Below this many filtered candidates we loosen the attraction-keyword gate. */
const MIN_BEFORE_LOOSEN = 8;

// ─── attraction classification ────────────────────────────────────────────────

/** Title/description tokens that signal a genuine visitor attraction. */
const ATTRACTION_KEYWORDS = [
  'museum', 'gallery', 'garden', 'palace', 'castle', 'park', 'church',
  'cathedral', 'tower', 'square', 'monument', 'landmark', 'zoo', 'theatre',
  'theater', 'harbour', 'harbor', 'statue', 'memorial', 'fortress', 'basilica',
  'temple', 'aquarium', 'botanical', 'planetarium', 'observatory', 'canal',
  'district', 'quarter', 'market', 'amusement', 'gate', 'fountain', 'opera',
  'art', 'historic', 'historical', 'waterfront', 'promenade', 'shrine',
  'chapel', 'abbey', 'citadel', 'pleasure', 'residence', 'mansion', 'cemetery',
  'lake', 'beach', 'island', 'plaza', 'piazza', 'mosque', 'synagogue',
  'pavilion', 'arena', 'amphitheatre', 'amphitheater', 'ruins', 'viewpoint',
  'house', 'hall',
];

/** Tokens that mark a page as NOT a visitor attraction — hard-drop these. */
const NOISE_RE = new RegExp(
  [
    'battle', 'siege', 'fire of', '\\briot', 'massacre', 'treaty', 'election',
    'referendum', 'company', 'corporation', '\\binc\\.', '\\bA/S\\b',
    'airport', 'stadium', 'statistics', 'business school', 'railway',
    '\\buniversity\\b', 'municipality', 'song contest', 'timeline', 'mutiny',
    'assault', '\\bwar\\b', '\\bbank\\b', 'ministry', 'embassy', 'parliament',
    'folketing', '\\bcouncil\\b', 'department', '\\bagency\\b', '\\binstitute\\b',
    '\\bschool\\b', 'hospital', '\\bstation\\b', 'federation', 'association',
    'political party', '\\bparty\\b', '\\bunion\\b', 'headquarters', 'court',
    'prison', 'factory', 'power plant', 'list of', 'census',
  ].join('|'),
  'i'
);

/** Map an attraction page to a coarse ActivityType for the UI icon. */
function classifyType(title: string, description: string): ActivityType {
  const hay = `${title} ${description}`.toLowerCase();
  if (/(museum|gallery|glyptotek|collection|exhibition)/.test(hay)) return 'museum';
  if (/(garden|park|botanical|zoo|lake|beach|island|forest|nature)/.test(hay)) return 'outdoors';
  if (/(palace|castle|fortress|citadel|cathedral|church|basilica|temple|monument|memorial|statue|historic|tower|ruins|abbey|chapel|royal)/.test(hay)) return 'history';
  if (/(market|food|restaurant|brewery|hall)/.test(hay)) return 'food';
  if (/(district|quarter|neighbourhood|neighborhood|waterfront|promenade|harbour|harbor|canal|square|street|plaza|piazza)/.test(hay)) return 'neighborhood';
  if (/(theatre|theater|opera|concert|arena|amphitheatre|amphitheater)/.test(hay)) return 'event';
  return 'other';
}

/** Attraction score: +ve = looks like a sight. Noise is dropped before this. */
function attractionScore(title: string, description: string): number {
  const hay = `${title} ${description}`.toLowerCase();
  let s = 0;
  for (const k of ATTRACTION_KEYWORDS) if (hay.includes(k)) s += 3;
  return s;
}

/**
 * Heuristic: does this thumbnail URL look like a poor lead image (a seal,
 * logo, coat of arms, map, flag or satellite capture) rather than a real
 * photo of the place? Used to *demote* (not drop) such POIs so the list still
 * fills up but real photos float to the top.
 */
function looksLikeBadPhoto(thumbUrl: string): boolean {
  const u = thumbUrl.toLowerCase();
  return /(segl|seal|logo|coat[_ ]of[_ ]arms|wappen|crest|\bflag\b|\.svg|sentinel|satellite|landsat|aerial|map[_ ]of|locator|\bicon\b)/.test(
    u
  );
}

// ─── response shapes (only the fields we read) ────────────────────────────────

interface WikiCoord {
  lat?: number;
  lon?: number;
}
interface WikiThumb {
  source?: string;
  width?: number;
  height?: number;
}
interface WikiPage {
  pageid?: number;
  title?: string;
  description?: string;
  coordinates?: WikiCoord[];
  thumbnail?: WikiThumb;
  index?: number;
}
interface WikiQueryResponse {
  query?: { pages?: Record<string, WikiPage> };
}
interface WikiPageviewsPage {
  title?: string;
  pageviews?: Record<string, number | null>;
}
interface WikiPageviewsResponse {
  query?: { pages?: Record<string, WikiPageviewsPage> };
}
interface OpenverseResult {
  url?: string;
  thumbnail?: string;
  license?: string;
  license_version?: string;
  creator?: string;
  source?: string;
  attribution?: string;
}
interface OpenverseResponse {
  results?: OpenverseResult[];
}

// ─── small fetch helper (UA + timeout + JSON) ─────────────────────────────────

async function getJson<T>(url: string, label: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `[wikimedia] ${label} network/timeout: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!res.ok) {
    throw new Error(`[wikimedia] ${label} HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(
      `[wikimedia] ${label} JSON parse: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ─── destination → coordinates ────────────────────────────────────────────────

/**
 * Resolve a free-form destination to lat/lng. Fast path is the shared curated
 * table (no network); fallback is Open-Meteo's keyless geocoding API. Returns
 * null only when both miss (caller surfaces destination_too_obscure).
 */
async function geocodeDestination(
  destination: string
): Promise<{ lat: number; lng: number } | null> {
  const local = resolveDestinationGeo(destination);
  if (local) return { lat: local.lat, lng: local.lon };

  // Open-Meteo geocoding needs a single token; take the part before the comma
  // ("Copenhagen, Denmark" -> "Copenhagen") for the cleanest match.
  const name = (destination.split(',')[0] || destination).trim();
  if (!name) return null;
  const url = `${GEOCODE_API}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  let body: { results?: Array<{ latitude?: number; longitude?: number }> };
  try {
    body = await getJson(url, 'geocode');
  } catch (err) {
    // Geocoding is a soft dependency — log + bail to null (no hard throw).
    console.log(
      `[wikimedia] geocode failed for "${destination}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
  const hit = body.results?.[0];
  if (
    hit &&
    typeof hit.latitude === 'number' &&
    typeof hit.longitude === 'number'
  ) {
    return { lat: hit.latitude, lng: hit.longitude };
  }
  return null;
}

// ─── candidate fetch + filter ─────────────────────────────────────────────────

/**
 * Relevance-ranked geo candidates with coords + lead photo + description in
 * one keyless call. nearcoord ranks by article relevance (not raw distance),
 * which is what surfaces the famous sights in dense city centres.
 */
async function fetchCandidates(
  lat: number,
  lng: number
): Promise<WikiPage[]> {
  const nearcoord = `nearcoord:${SEARCH_RADIUS_KM}km,${lat},${lng}`;
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: nearcoord,
    gsrnamespace: '0',
    gsrlimit: String(CANDIDATE_LIMIT),
    prop: 'coordinates|pageimages|description',
    colimit: 'max', // REQUIRED: coordinates module defaults to 10 otherwise.
    coprimary: 'primary',
    pilimit: 'max',
    piprop: 'thumbnail',
    pithumbsize: String(THUMB_PX),
    format: 'json',
    origin: '*',
  });
  const json = await getJson<WikiQueryResponse>(
    `${WIKI_API}?${params.toString()}`,
    'geosearch'
  );
  const pages = json.query?.pages ? Object.values(json.query.pages) : [];
  return pages;
}

/**
 * Keep only real attractions: thumbnail + description + coordinates present,
 * not obvious noise. Prefer attraction-y pages; loosen if too few survive.
 * Dedups by lowercase title.
 */
function filterAttractions(pages: WikiPage[]): WikiPage[] {
  const usable = pages.filter(
    (p) =>
      p.title &&
      p.thumbnail &&
      p.thumbnail.source &&
      p.description &&
      p.coordinates &&
      p.coordinates[0] &&
      typeof p.coordinates[0].lat === 'number' &&
      typeof p.coordinates[0].lon === 'number' &&
      !NOISE_RE.test(`${p.title} ${p.description}`)
  );

  let attractions = usable.filter(
    (p) => attractionScore(p.title ?? '', p.description ?? '') > 0
  );
  // If the keyword gate is too strict for this destination, fall back to all
  // usable (still photo+desc+coords+non-noise) candidates.
  if (attractions.length < MIN_BEFORE_LOOSEN) attractions = usable;

  const seen = new Set<string>();
  return attractions.filter((p) => {
    const key = (p.title ?? '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sum per-page views over the recent window (keyless PageViewInfo extension,
 * batched in one call). Missing pages → 0. Used to rank by real prominence.
 */
async function fetchPageviews(titles: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (titles.length === 0) return out;
  const params = new URLSearchParams({
    action: 'query',
    prop: 'pageviews',
    titles: titles.join('|'),
    pvipdays: String(PAGEVIEW_DAYS),
    format: 'json',
    origin: '*',
  });
  let json: WikiPageviewsResponse;
  try {
    json = await getJson<WikiPageviewsResponse>(
      `${WIKI_API}?${params.toString()}`,
      'pageviews'
    );
  } catch (err) {
    // Prominence is a nice-to-have; on failure keep relevance order (all 0).
    console.log(
      `[wikimedia] pageviews failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return out;
  }
  const pages = json.query?.pages ? Object.values(json.query.pages) : [];
  for (const p of pages) {
    if (!p.title) continue;
    const views = p.pageviews ?? {};
    let sum = 0;
    for (const v of Object.values(views)) sum += v ?? 0;
    out.set(p.title, sum);
  }
  return out;
}

// ─── Openverse photo fallback (keyless CC image search) ───────────────────────

/**
 * Best-effort CC image for a POI when Wikimedia gave us no thumbnail. Returns
 * {url, attribution} or null. Never throws — fallback is optional.
 */
async function openversephoto(
  query: string
): Promise<{ url: string; attribution: string } | null> {
  const url = `${OPENVERSE_API}?q=${encodeURIComponent(query)}&page_size=1`;
  let json: OpenverseResponse;
  try {
    json = await getJson<OpenverseResponse>(url, 'openverse');
  } catch {
    return null;
  }
  const r = json.results?.[0];
  if (!r || !r.url) return null;
  const lic = r.license
    ? `CC ${r.license.toUpperCase()}${r.license_version ? ' ' + r.license_version : ''}`
    : 'CC';
  const who = r.creator ? ` · ${r.creator}` : '';
  const where = r.source ? ` (${r.source})` : '';
  return { url: r.url, attribution: `${lic}${who}${where}`.trim() };
}

// ─── build the ActivityItem ───────────────────────────────────────────────────

function wikipediaUrl(title: string): string {
  // Wikipedia accepts spaces-as-underscores; encodeURIComponent handles the
  // rest (leaves it readable for ASCII titles, escapes the unicode ones).
  return `https://${WIKI_LANG}.wikipedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, '_')
  )}`;
}

function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

async function pageToItem(p: WikiPage): Promise<ActivityItem | null> {
  const title = p.title;
  const coord = p.coordinates?.[0];
  if (!title || !coord || typeof coord.lat !== 'number' || typeof coord.lon !== 'number') {
    return null;
  }
  const description = p.description ?? '';
  const lat = coord.lat;
  const lng = coord.lon;

  let imageUrl = p.thumbnail?.source;
  let photoAttribution: string | undefined;
  // No thumbnail, or a poor lead image (seal/logo/satellite) → try a keyless
  // Openverse CC photo. Keep the Wikimedia image if Openverse has nothing.
  if (!imageUrl || looksLikeBadPhoto(imageUrl)) {
    const fb = await openversephoto(`${title}`);
    if (fb) {
      imageUrl = fb.url;
      photoAttribution = fb.attribution;
    }
  }

  return {
    name: title.slice(0, 80),
    type: classifyType(title, description),
    dateRange: 'all year',
    paid: false, // We don't know pricing — show no invented price (UI: "Gratis"
    priceEur: null, //  is misleading for paid sights, but mock uses same default).
    whyOneSentence: (description || `A notable sight in the area.`).slice(0, 160),
    confidence: 'high', // evergreen, real, verifiable via the Wikipedia link
    source: 'wikimedia',
    imageUrl,
    photoAttribution,
    link: wikipediaUrl(title),
    mapsUrl: mapsUrl(lat, lng),
    lat,
    lng,
  };
}

// ─── provider ─────────────────────────────────────────────────────────────────

export interface WikimediaActivityProviderOptions {
  /** Optional OpenTripMap key — currently unused on the default path; the
   *  Wikipedia-only pipeline runs without it. Reserved for the enrichment
   *  branch so the constructor matches the env-gated factory. */
  openTripMapApiKey?: string;
}

export class WikimediaActivityProvider implements ActivityProvider {
  readonly name = 'wikimedia';
  readonly isReal = true;

  /** OpenTripMap key, if supplied. Reserved for the optional enrichment path;
   *  the default pipeline is Wikipedia-only and ignores it. */
  private readonly openTripMapApiKey?: string;

  constructor(options: WikimediaActivityProviderOptions = {}) {
    this.openTripMapApiKey = options.openTripMapApiKey;
  }

  async fetchActivities(
    input: ActivitySearchInput
  ): Promise<ActivitySearchResult> {
    const destination = (input.destination ?? '').trim();
    if (!destination) {
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'destination_too_obscure',
      };
    }

    // OpenTripMap enrichment is an opt-in future path; the default keyless
    // Wikipedia pipeline runs regardless. Surfacing the flag keeps the wiring
    // observable in logs without changing behaviour.
    if (this.openTripMapApiKey) {
      console.log('[wikimedia] OpenTripMap key present — using Wikipedia path (enrichment not yet wired)');
    }

    const geo = await geocodeDestination(destination);
    if (!geo) {
      // Couldn't place the destination — not a hard error, just no data.
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'destination_too_obscure',
      };
    }

    // 1. candidates (throws on hard transport failure → provider_error)
    const candidates = await fetchCandidates(geo.lat, geo.lng);

    // 2. filter to real attractions
    const attractions = filterAttractions(candidates);
    if (attractions.length === 0) {
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'destination_too_obscure',
      };
    }

    // 3. re-rank by prominence (pageviews). Primary key: real photo over
    //    seal/logo/satellite thumbnails (keeps the card grid looking right);
    //    secondary key: pageview prominence; ties keep relevance order.
    const views = await fetchPageviews(
      attractions.map((p) => p.title ?? '').filter(Boolean)
    );
    const goodPhoto = (p: WikiPage): number =>
      p.thumbnail?.source && !looksLikeBadPhoto(p.thumbnail.source) ? 1 : 0;
    attractions.sort((a, b) => {
      const pg = goodPhoto(b) - goodPhoto(a);
      if (pg !== 0) return pg;
      return (views.get(b.title ?? '') ?? 0) - (views.get(a.title ?? '') ?? 0);
    });

    // 4. build items (photo fallback only fires for the rare no-thumb page)
    const top = attractions.slice(0, MAX_RESULTS);
    const items = (await Promise.all(top.map(pageToItem))).filter(
      (x): x is ActivityItem => x !== null
    );

    if (items.length === 0) {
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'destination_too_obscure',
      };
    }

    // Evergreen sights → alwaysGreat. No date signal, so thisWeek stays empty.
    return {
      activities: { thisWeek: [], alwaysGreat: items },
      reason: 'ok',
    };
  }
}
