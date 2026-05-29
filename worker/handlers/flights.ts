// worker/handlers/flights.ts
// Phase 5 — GET /api/flights?slug=X&token=Y
//
// Per-participant flight options. Cache-first: if proposal_cache has fresh
// data for this participant + date pair + provider, return it; otherwise
// call the configured provider, store, return. Cache TTL: 24h.
//
// Always 200 (unless slug/token bad) — graceful reasons in the body so the
// frontend can render a friendly state:
//   'ok'                  — flights[] is populated
//   'profile_incomplete'  — participant has no homeAirport
//   'destination_unmapped'— poll.destination doesn't map to IATA
//   'no_routes'           — provider returned 0 offers
//   'provider_error'      — provider blew up (returns stale cache if any)
//   'not_configured'/'api_down' — legacy reasons, still tolerated in cache.

import type {
  Env,
  WhenWeGoPollDO,
  ParticipantProfile,
} from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import {
  findPoll,
  validateParticipantToken,
  type Poll,
} from '../lib/polls-config';
import {
  searchFlights,
  buildFlightCachePayload,
  type FlightCachePayload,
} from '../lib/flights';
import { getFlightProvider } from '../lib/flight-provider';
import { resolveDestinationIata, cityForIata } from '../lib/destinations';
import { computeTripStart } from '../lib/trip-date';
import type { Overlap } from '../lib/overlap';
import { addDaysIso } from '../lib/ical';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Resolve the date pair to search for. Order of preference:
 *   1. featured overlap range (when poll is closed + overlap has consensus)
 *   2. poll.dateRangeStart .. poll.dateRangeEnd (raw poll window)
 * `start` = depart date, `end` = return date.
 */
function resolveDatePair(
  poll: Poll,
  overlap: Overlap | null
): { start: string; end: string } | null {
  const featured = overlap?.ranges?.[0] ?? null;
  if (featured) {
    return { start: featured.start, end: featured.end };
  }
  if (poll.dateRangeStart && poll.dateRangeEnd) {
    return { start: poll.dateRangeStart, end: poll.dateRangeEnd };
  }
  return null;
}

/**
 * Build the cache key for a given participant / date pair / provider.
 * Provider name is included so swapping providers later invalidates cleanly.
 */
function cacheKeyFor(
  token: string,
  datePair: { start: string; end: string } | null,
  providerName: string
): string {
  if (!datePair) return `flights:${token}:nodate:${providerName}`;
  return `flights:${token}:${datePair.start}:${datePair.end}:${providerName}`;
}

/**
 * Shared core used by both the participant GET and the admin GET. Returns
 * the cached payload shape (no Response wrapping — caller decides).
 *
 * `forceRefresh` skips the cache read but still writes the fresh result.
 */
export async function loadFlightsForParticipant(args: {
  env: Env;
  poll: Poll;
  token: string;
  forceRefresh?: boolean;
}): Promise<FlightCachePayload> {
  const { env, poll, token, forceRefresh = false } = args;
  const provider = getFlightProvider(env);
  const providerInfo = { name: provider.name, isReal: provider.isReal };

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(poll.slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const [profile, overlapRaw] = await Promise.all([
    stub.getProfile(token) as Promise<ParticipantProfile | null>,
    stub.getMeta('overlap_cache'),
  ]);

  let overlap: Overlap | null = null;
  if (overlapRaw) {
    try {
      overlap = JSON.parse(overlapRaw as string) as Overlap;
    } catch {
      overlap = null;
    }
  }

  const originIata = profile?.homeAirport?.toUpperCase() ?? '';
  const destinationIata = resolveDestinationIata(
    poll.destination ?? poll.title ?? ''
  );
  const datePair = resolveDatePair(poll, overlap);
  const cacheKey = cacheKeyFor(token, datePair, provider.name);

  const pkg = (
    reason: FlightCachePayload['reason'],
    flights: FlightCachePayload['flights']
  ): FlightCachePayload =>
    buildFlightCachePayload({
      reason,
      flights,
      origin: { iata: originIata || '' },
      destination: { iata: destinationIata ?? '' },
      dateRange: {
        start: datePair?.start ?? '',
        end: datePair?.end ?? '',
      },
      provider: providerInfo,
    });

  // Early bail-outs that don't even attempt the provider.
  if (!originIata) return pkg('profile_incomplete', []);
  if (!destinationIata) return pkg('destination_unmapped', []);
  if (!datePair) return pkg('no_routes', []);

  // Cache check (unless forced).
  if (!forceRefresh) {
    const cachedRaw = await stub.getCached(cacheKey);
    if (cachedRaw) {
      try {
        return JSON.parse(cachedRaw) as FlightCachePayload;
      } catch {
        // Corrupt cache — fall through to fresh fetch.
      }
    }
  }

  // Fresh fetch via the provider abstraction.
  const result = await searchFlights({
    env,
    originIata,
    destinationIata,
    departDate: datePair.start,
    returnDate: datePair.end,
  });

  // provider_error + we have a stale cache → prefer stale over empty.
  if (result.reason === 'provider_error') {
    const staleRaw = await stub.getCached(cacheKey);
    if (staleRaw) {
      try {
        return JSON.parse(staleRaw) as FlightCachePayload;
      } catch {
        // fall through
      }
    }
  }

  const payload = pkg(result.reason, result.flights);

  // Only cache successful + empty-result payloads (not transient errors).
  if (payload.reason === 'ok' || payload.reason === 'no_routes') {
    try {
      await stub.setCached(cacheKey, JSON.stringify(payload), CACHE_TTL_MS);
    } catch (err) {
      console.error('[flights] could not write cache', err);
    }
  }

  return payload;
}

export async function handleFlights(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (!slug || !token) {
    return errorResponse('Missing slug or token', 400, req, env);
  }

  const poll = findPoll(env, slug);
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }
  const participant = validateParticipantToken(poll, token);
  if (!participant) {
    // Wrong token → 404 (consistency with other handlers).
    return errorResponse('Not found', 404, req, env);
  }

  let payload: FlightCachePayload;
  try {
    payload = await loadFlightsForParticipant({ env, poll, token });
  } catch (err) {
    console.error('[flights] unexpected handler error', err);
    const provider = getFlightProvider(env);
    payload = {
      fetchedAt: Date.now(),
      reason: 'provider_error',
      flights: [],
      proposals: [],
      origin: { iata: '' },
      destination: { iata: '' },
      dateRange: { start: '', end: '' },
      provider: { name: provider.name, isReal: provider.isReal },
    };
  }

  return jsonResponse(
    {
      fetchedAt: payload.fetchedAt,
      flights: payload.flights,
      reason: payload.reason,
      provider: payload.provider,
      origin: {
        iata: payload.origin.iata,
        city: cityForIata(payload.origin.iata) ?? payload.origin.iata,
      },
      destination: {
        iata: payload.destination.iata,
        city: cityForIata(payload.destination.iata) ?? payload.destination.iata,
      },
      dateRange: payload.dateRange,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}

// Re-export internals the cron extension needs.
export { computeTripStart, addDaysIso };
