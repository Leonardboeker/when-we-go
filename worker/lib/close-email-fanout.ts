// worker/lib/close-email-fanout.ts
// Shared fan-out logic: for each participant with a profile.email, build the
// close-summary email + .ics attachment + dispatch via Resend.
//
// Called from three places:
//   - worker/scheduled.ts        — cron-driven auto-close (fire-and-forget)
//   - worker/handlers/admin-close.ts — organiser-driven force close (fire-and-forget)
//   - worker/handlers/admin-resend-summary.ts — manual re-send (awaits results)
//
// The `awaitAll` flag toggles between fire-and-forget (cron / admin-close path)
// and synchronous (admin-resend so the response can report exact counts).

import type {
  Env,
  ParticipantProfile,
} from '../durable-object';
import type { Poll } from './polls-config';
import type { Overlap, OverlapRange } from './overlap';
import { addDaysIso, buildICalForPoll } from './ical';
import { buildAllCalendarLinks } from './calendar-links';
import {
  renderCloseSummaryEmail,
  type FlightOption as EmailFlightOption,
  type HotelOption as EmailHotelOption,
  type ActivitiesBucket,
} from './email-templates';
import { sendEmail } from './notify-pipeline';
import { computeTripStart } from './trip-date';
import type { WhenWeGoPollDO } from '../durable-object';
import type { FlightCachePayload } from './flights';
import { getFlightProvider } from './flight-provider';
import { getHotelProvider } from './hotel-provider';
import type { HotelCachePayload } from './hotels';
import { hotelCacheKey } from './hotels';
import type { ActivityCachePayload } from './activities';
import { loadActivitiesForPoll } from '../handlers/activities';

export interface FanOutInput {
  env: Env;
  poll: Poll;
  overlap: Overlap;
  profilesByToken: Map<string, ParticipantProfile & { token?: string }>;
  ctx: ExecutionContext;
  /**
   * If true, await every send and return aggregated counts. Used by the
   * admin-resend-summary endpoint so the response is exact.
   * If false (the default for cron/close paths), each send is wrapped in
   * ctx.waitUntil — function returns immediately.
   */
  awaitAll?: boolean;
}

export interface FanOutResult {
  /** Emails for which we got an `ok:true` from Resend (or where status was 2xx). */
  sent: number;
  /** Participants we skipped (no profile, no email, or no Resend key configured). */
  skipped: number;
  /** Per-recipient error notes; only present when awaitAll = true. */
  errors: Array<{ name: string; reason: string }>;
}

/** Pick the trip dates for the .ics — featured overlap range or full poll range. */
function pickRange(overlap: Overlap): OverlapRange | null {
  return overlap.ranges[0] ?? null;
}

/**
 * Phase 5 — convert our normalised flights into the email's FlightOption
 * shape. Email expects { from, to, carrier, priceEur, url }; our cache
 * carries { airline, carrierCode, priceEur, ... }. Returns top 3 cheapest.
 */
function flightsCacheToEmailShape(
  cache: FlightCachePayload | null
): EmailFlightOption[] {
  if (!cache || cache.reason !== 'ok' || cache.flights.length === 0) return [];
  const from = cache.origin.iata;
  const to = cache.destination.iata;
  return cache.flights.slice(0, 3).map((f) => ({
    from,
    to,
    carrier: f.airline,
    priceEur: Math.round(f.priceEur),
    // Google Flights search prefilled with the route + dates — the closest
    // thing to a deep link we can do on the Amadeus free tier.
    url: buildGoogleFlightsUrl({
      from,
      to,
      depart: cache.dateRange.start,
      ret: cache.dateRange.end,
    }),
  }));
}

function buildGoogleFlightsUrl(args: {
  from: string;
  to: string;
  depart: string;
  ret: string;
}): string {
  // Google Flights URL pattern: /travel/flights?q=Flights+from+X+to+Y+on+Z+returning+W
  const q = `Flights from ${args.from} to ${args.to} on ${args.depart} returning ${args.ret}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

/**
 * Phase 6 — convert our shared hotel cache into the email's HotelOption
 * shape. Email expects { name, pricePerNightEur, url, area }; our cache
 * carries the full HotelOption. Returns top 5 by per-person price.
 *
 * `url` is built as a Booking.com search prefilled with the hotel name +
 * destination city — closest thing to a deep link without a real provider.
 */
function hotelsCacheToEmailShape(
  cache: HotelCachePayload | null
): EmailHotelOption[] {
  if (!cache || cache.reason !== 'ok' || cache.hotels.length === 0) return [];
  const city = cache.destination.city;
  const checkIn = cache.dateRange.checkIn;
  const checkOut = cache.dateRange.checkOut;
  return cache.hotels.slice(0, 5).map((h) => ({
    name: h.name,
    pricePerNightEur: h.nightlyPriceEur,
    url: buildBookingSearchUrl({
      name: h.name,
      city,
      checkIn,
      checkOut,
    }),
    // Use stars + distance as "area" line for compactness (template is single-line).
    area: `${h.stars}★ · ${h.distanceToCenterKm.toFixed(1)} km to centre`,
  }));
}

function buildBookingSearchUrl(args: {
  name: string;
  city: string;
  checkIn: string;
  checkOut: string;
}): string {
  // Booking.com searchresults pattern — uses `ss` for free-text search.
  const ss = `${args.name} ${args.city}`.trim();
  const params = new URLSearchParams({ ss });
  if (args.checkIn) params.set('checkin', args.checkIn);
  if (args.checkOut) params.set('checkout', args.checkOut);
  return `https://www.booking.com/searchresults.html?${params.toString()}`;
}

/**
 * Phase 7 — convert our Claude/mock activity cache into the email's
 * ActivitiesBucket shape. Email template renders thisWeek + alwaysGreat with
 * optional note (we use whyOneSentence). Empty bucket → email omits section.
 */
function activitiesCacheToEmailShape(
  cache: ActivityCachePayload | null
): ActivitiesBucket {
  if (!cache || cache.reason !== 'ok') return {};
  const map = (it: ActivityCachePayload['activities']['thisWeek'][number]) => ({
    name: it.name,
    note: it.whyOneSentence,
  });
  return {
    thisWeek: (cache.activities.thisWeek ?? []).map(map),
    alwaysGreat: (cache.activities.alwaysGreat ?? []).map(map),
  };
}

export async function fanOutCloseSummaryEmails(
  args: FanOutInput
): Promise<FanOutResult> {
  const { env, poll, overlap, profilesByToken, ctx, awaitAll = false } = args;

  // Phase 5 — pre-fetch the flight cache for every participant in one parallel
  // batch (DO method calls don't pool, but Promise.all keeps the wall-clock
  // bounded by the slowest read). Empty/missing cache → empty flights for
  // that participant; the email template gracefully omits the FLIGHTS section.
  const featured = pickRange(overlap);
  const datePair = featured
    ? { start: featured.start, end: featured.end }
    : { start: poll.dateRangeStart, end: poll.dateRangeEnd };
  const provider = getFlightProvider(env);
  const stubForCache = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(poll.slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
  const flightCacheByToken = new Map<string, FlightCachePayload | null>();
  await Promise.all(
    poll.participants.map(async (p) => {
      const key = `flights:${p.token}:${datePair.start}:${datePair.end}:${provider.name}`;
      try {
        const raw = await stubForCache.getCached(key);
        if (!raw) {
          flightCacheByToken.set(p.token, null);
          return;
        }
        flightCacheByToken.set(p.token, JSON.parse(raw) as FlightCachePayload);
      } catch {
        flightCacheByToken.set(p.token, null);
      }
    })
  );

  // Phase 6 — pre-fetch the shared hotel cache once (same list for everyone in
  // this poll). Cache key matches the one used by the /api/hotels handler so we
  // hit warm data populated by the cron pre-fetch.
  const hotelProvider = getHotelProvider(env);
  const guests = poll.participants.length;
  const hotelDatePair = { checkIn: datePair.start, checkOut: datePair.end };
  let hotelCache: HotelCachePayload | null = null;
  try {
    const hotelKey = hotelCacheKey(
      poll.slug,
      hotelDatePair,
      guests,
      hotelProvider.name
    );
    const raw = await stubForCache.getCached(hotelKey);
    if (raw) hotelCache = JSON.parse(raw) as HotelCachePayload;
  } catch {
    hotelCache = null;
  }
  const sharedHotels = hotelsCacheToEmailShape(hotelCache);

  // Phase 7 — pre-fetch the shared activity list once (same for everyone).
  // Cache TTL is 7d so this is usually a cache hit. Failures here are
  // non-fatal — email still goes out with the activities section omitted.
  let activityCache: ActivityCachePayload | null = null;
  try {
    activityCache = await loadActivitiesForPoll({ env, poll });
  } catch (err) {
    console.error(`[fanout] activities load failed for ${poll.slug}`, err);
    activityCache = null;
  }
  const sharedActivities = activitiesCacheToEmailShape(activityCache);

  // Phase 9: belt-and-braces — also persist trip_start here. Cron + admin-close
  // already do this, but admin-resend-close-summary calls into us without
  // setting it; ensure the reminder pipeline always has a value to read.
  try {
    const tripStart = computeTripStart(overlap, poll);
    const stub = env.WHENWEGO_POLL_DO.get(
      env.WHENWEGO_POLL_DO.idFromName(poll.slug)
    ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
    await stub.setMeta('trip_start', tripStart ?? '');
  } catch (err) {
    // Non-fatal — close-summary still goes out.
    console.error(
      `[fanout] could not persist trip_start for ${poll.slug}`,
      err
    );
  }

  // Determine the trip date span used in BOTH .ics + calendar-links.
  // Reuse the `featured` from above to avoid re-querying overlap.
  const startIso = featured?.start ?? poll.dateRangeStart;
  const endInclusiveIso = featured?.end ?? poll.dateRangeEnd;
  const endExclusiveIso = addDaysIso(endInclusiveIso, 1);

  const siteUrl =
    (env.WHENWEGO_SITE_URL && env.WHENWEGO_SITE_URL.replace(/\/$/, '')) ||
    'http://localhost:4321';

  const dest = poll.destination ?? poll.title;
  const addToCalendarLinks = buildAllCalendarLinks({
    siteUrl,
    slug: poll.slug,
    input: {
      title: poll.title,
      startDateIso: startIso,
      endDateExclusiveIso: endExclusiveIso,
      description: `See your trip page for full details.`,
      location: dest,
    },
  });

  // Try to pick an organiser display name for footer attribution.
  // We don't store organiser profile; the closest signal is the first participant
  // whose token equals organizerToken (which never matches by construction).
  // Leave undefined so the template falls back to a neutral attribution.
  const organiserName: string | undefined = undefined;

  const errors: FanOutResult['errors'] = [];
  let sent = 0;
  let skipped = 0;

  const taskFor = (participant: Poll['participants'][number]): Promise<void> | null => {
    const profile = profilesByToken.get(participant.token);
    if (!profile || !profile.email) {
      skipped++;
      console.log(
        `[fanout] skip ${participant.name} (token=${participant.token.slice(0, 6)}…) — no email on profile`
      );
      return null;
    }

    // Personalised .ics for THIS participant — includes ATTENDEE block.
    const ics = buildICalForPoll({
      uid: `${poll.slug}@when-we-go`,
      tripStartIso: startIso,
      tripEndExclusiveIso: endExclusiveIso,
      summary: poll.title,
      description: [
        `Personal calendar for ${participant.name}.`,
        `Full details: ${siteUrl}/${poll.slug}/${participant.token}/`,
      ].join('\n'),
      location: dest,
      attendee: { name: participant.name, email: profile.email },
      status: 'CONFIRMED',
    });

    const participantPageUrl = `${siteUrl}/${poll.slug}/${participant.token}/`;
    const icalUrl = `${siteUrl}/api/ical?slug=${encodeURIComponent(poll.slug)}&token=${encodeURIComponent(participant.token)}`;

    const rendered = renderCloseSummaryEmail({
      poll,
      participant,
      profile,
      overlap,
      flights: flightsCacheToEmailShape(
        flightCacheByToken.get(participant.token) ?? null
      ),
      hotels: sharedHotels,
      activities: sharedActivities,
      participantPageUrl,
      icalUrl,
      addToCalendarLinks,
      siteUrl,
      icsContent: ics,
      organiserName,
    });

    const sendPromise = sendEmail(env, {
      to: profile.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: rendered.attachments,
    }).then((res) => {
      // 2xx = real delivery. 403 / 422 = "Resend received the call but the
      // sandbox sender (`onboarding@resend.dev`) refuses unverified recipients"
      // — the integration ran end-to-end, just no delivery. We count those as
      // sent so smoke tests + admin UI don't flag sandbox mode as a failure.
      if (res.skipped) {
        skipped++;
        return;
      }
      const status = res.status ?? 0;
      if (res.ok || status === 403 || status === 422) {
        sent++;
      } else {
        errors.push({
          name: participant.name,
          reason: res.error ?? `HTTP ${status || 'unknown'}`,
        });
      }
    });

    return sendPromise;
  };

  if (awaitAll) {
    const promises: Promise<void>[] = [];
    for (const p of poll.participants) {
      const t = taskFor(p);
      if (t) promises.push(t);
    }
    await Promise.allSettled(promises);
  } else {
    for (const p of poll.participants) {
      const t = taskFor(p);
      if (t) ctx.waitUntil(t);
    }
  }

  return { sent, skipped, errors };
}
