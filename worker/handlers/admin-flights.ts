// worker/handlers/admin-flights.ts
// Phase 5 — GET /api/admin/flights?slug=X
//
// Organiser-only summary of every participant's flight options. Useful for the
// admin dashboard's "All flights" table — one row per participant with their
// cheapest option, so the organiser can eyeball total trip cost before
// committing.
//
// Cache-only: this endpoint does NOT trigger fresh provider fetches (would
// burn quota every dashboard load when a real provider is wired). Returns
// whatever is currently in the proposal_cache, plus a reason flag per
// participant when no cache exists.
//
// Auth: X-Organizer-Token header. Wrong/missing → 404.

import type {
  Env,
  WhenWeGoPollDO,
  ParticipantProfile,
} from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import type { Overlap } from '../lib/overlap';
import type { FlightCachePayload, FlightReason } from '../lib/flights';
import { getFlightProvider } from '../lib/flight-provider';
import { resolveDestinationIata, cityForIata } from '../lib/destinations';

interface ParticipantFlightSummary {
  token: string;
  name: string;
  reason: FlightReason | 'not_fetched';
  cheapestEur: number | null;
  cheapestCarrier: string | null;
  totalOffers: number;
  fetchedAt: number | null;
  origin: { iata: string; city: string } | null;
  destination: { iata: string; city: string } | null;
  dateRange: { start: string; end: string } | null;
}

export async function handleAdminFlights(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
  }
  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  const provider = getFlightProvider(env);

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // Pull overlap + all profiles in parallel.
  const [overlapRaw, allProfiles] = await Promise.all([
    stub.getMeta('overlap_cache'),
    stub.getAllProfiles(),
  ]);

  let overlap: Overlap | null = null;
  if (overlapRaw) {
    try {
      overlap = JSON.parse(overlapRaw as string) as Overlap;
    } catch {
      overlap = null;
    }
  }

  // Determine the date pair we'd be searching (same logic as the per-participant
  // handler so cache keys line up).
  const featured = overlap?.ranges?.[0] ?? null;
  const datePair =
    featured
      ? { start: featured.start, end: featured.end }
      : poll.dateRangeStart && poll.dateRangeEnd
        ? { start: poll.dateRangeStart, end: poll.dateRangeEnd }
        : null;

  const profileByToken = new Map(
    (allProfiles as Array<{ token: string } & ParticipantProfile>).map((p) => [
      p.token,
      p,
    ])
  );

  // Resolve destination once (same for every participant).
  const destinationIata = resolveDestinationIata(
    poll.destination ?? poll.title ?? ''
  );
  const destinationCity = destinationIata
    ? cityForIata(destinationIata) ?? destinationIata
    : null;

  // Build cache keys + pull all entries in parallel. Cache key includes
  // provider name so swapping providers later invalidates cleanly.
  const fetches: Array<Promise<string | null>> = [];
  for (const p of poll.participants) {
    if (!datePair) {
      fetches.push(Promise.resolve(null));
      continue;
    }
    fetches.push(
      stub.getCached(
        `flights:${p.token}:${datePair.start}:${datePair.end}:${provider.name}`
      )
    );
  }
  const cacheResults = await Promise.all(fetches);

  const summaries: ParticipantFlightSummary[] = poll.participants.map(
    (participant, i) => {
      const profile = profileByToken.get(participant.token);
      const homeAirport = profile?.homeAirport?.toUpperCase() ?? '';
      const baseSummary: ParticipantFlightSummary = {
        token: participant.token,
        name: participant.name,
        reason: 'not_fetched',
        cheapestEur: null,
        cheapestCarrier: null,
        totalOffers: 0,
        fetchedAt: null,
        origin: homeAirport
          ? { iata: homeAirport, city: cityForIata(homeAirport) ?? homeAirport }
          : null,
        destination:
          destinationIata && destinationCity
            ? { iata: destinationIata, city: destinationCity }
            : null,
        dateRange: datePair,
      };

      if (!homeAirport) {
        baseSummary.reason = 'profile_incomplete';
        return baseSummary;
      }
      if (!destinationIata) {
        baseSummary.reason = 'destination_unmapped';
        return baseSummary;
      }
      if (!datePair) {
        baseSummary.reason = 'no_routes';
        return baseSummary;
      }

      const raw = cacheResults[i];
      if (!raw) {
        baseSummary.reason = 'not_fetched';
        return baseSummary;
      }
      try {
        const parsed = JSON.parse(raw) as FlightCachePayload;
        const cheapest = parsed.flights?.[0] ?? null;
        baseSummary.reason = parsed.reason;
        baseSummary.cheapestEur = cheapest ? cheapest.priceEur : null;
        baseSummary.cheapestCarrier = cheapest ? cheapest.airline : null;
        baseSummary.totalOffers = parsed.flights?.length ?? 0;
        baseSummary.fetchedAt = parsed.fetchedAt ?? null;
        return baseSummary;
      } catch {
        baseSummary.reason = 'provider_error';
        return baseSummary;
      }
    }
  );

  return jsonResponse(
    {
      ok: true,
      slug: poll.slug,
      provider: { name: provider.name, isReal: provider.isReal },
      destination:
        destinationIata && destinationCity
          ? { iata: destinationIata, city: destinationCity }
          : null,
      dateRange: datePair,
      participants: summaries,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
