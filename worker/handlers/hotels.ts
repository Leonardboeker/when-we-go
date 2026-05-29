// worker/handlers/hotels.ts
// Phase 6 — GET /api/hotels?slug=X&token=Y
//
// Shared hotel shortlist for the destination + dates. Cache-first: if
// proposal_cache has fresh data for this (slug, dateRange, guests, provider)
// tuple, return it; otherwise call the configured provider, store, return.
// Cache TTL: 24h.
//
// Auth: any valid participant token. Wrong token → 404.
//
// Always 200 (unless slug/token bad) — graceful reasons in the body so the
// frontend can render a friendly state:
//   'ok'                  — hotels[] is populated
//   'destination_unmapped'— poll.destination doesn't map to IATA
//   'no_inventory'        — provider returned 0 hotels
//   'provider_error'      — provider blew up (returns stale cache if any)
//
// Also surfaces:
//   - chosenHotelId        — poll_meta.chosen_hotel (set by /api/admin/hotel-choose)
//   - voteTallies          — { hotelId: voteCount } from poll_meta.hotel_votes:*

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import {
  findPoll,
  validateParticipantToken,
  type Poll,
} from '../lib/polls-config';
import {
  searchHotels,
  buildHotelCachePayload,
  hotelCacheKey,
  type HotelCachePayload,
} from '../lib/hotels';
import { getHotelProvider } from '../lib/hotel-provider';
import { resolveDestinationIata, cityForIata } from '../lib/destinations';
import type { Overlap } from '../lib/overlap';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Resolve check-in / check-out from the closed-overlap (preferred) or fall
 * back to the raw poll window. checkIn = overlap start, checkOut = overlap
 * end (kept inclusive in our overlap shape, callers pass through to the
 * provider — mock treats them as inclusive→exclusive via nights calc).
 */
function resolveDatePair(
  poll: Poll,
  overlap: Overlap | null
): { checkIn: string; checkOut: string } | null {
  const featured = overlap?.ranges?.[0] ?? null;
  if (featured) {
    return { checkIn: featured.start, checkOut: featured.end };
  }
  if (poll.dateRangeStart && poll.dateRangeEnd) {
    return { checkIn: poll.dateRangeStart, checkOut: poll.dateRangeEnd };
  }
  return null;
}

/**
 * Shared core used by both the participant GET and the cron pre-fetch. Returns
 * the cached payload shape (no Response wrapping — caller decides).
 *
 * `forceRefresh` skips the cache read but still writes the fresh result.
 */
export async function loadHotelsForPoll(args: {
  env: Env;
  poll: Poll;
  forceRefresh?: boolean;
}): Promise<HotelCachePayload> {
  const { env, poll, forceRefresh = false } = args;
  const provider = getHotelProvider(env);
  const providerInfo = { name: provider.name, isReal: provider.isReal };

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(poll.slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const overlapRaw = await stub.getMeta('overlap_cache');
  let overlap: Overlap | null = null;
  if (overlapRaw) {
    try {
      overlap = JSON.parse(overlapRaw as string) as Overlap;
    } catch {
      overlap = null;
    }
  }

  const destinationIata = resolveDestinationIata(
    poll.destination ?? poll.title ?? ''
  );
  const destinationCity = destinationIata
    ? cityForIata(destinationIata) ?? destinationIata
    : poll.destination ?? '';
  const datePair = resolveDatePair(poll, overlap);
  const guests = poll.participants.length;

  const cacheKey = hotelCacheKey(poll.slug, datePair, guests, provider.name);

  const pkg = (
    reason: HotelCachePayload['reason'],
    hotels: HotelCachePayload['hotels']
  ): HotelCachePayload =>
    buildHotelCachePayload({
      reason,
      hotels,
      destination: { iata: destinationIata ?? '', city: destinationCity },
      dateRange: {
        checkIn: datePair?.checkIn ?? '',
        checkOut: datePair?.checkOut ?? '',
      },
      guests,
      provider: providerInfo,
    });

  // Early bail-outs that don't even attempt the provider.
  if (!destinationIata) return pkg('destination_unmapped', []);
  if (!datePair) return pkg('no_inventory', []);

  // Cache check (unless forced).
  if (!forceRefresh) {
    const cachedRaw = await stub.getCached(cacheKey);
    if (cachedRaw) {
      try {
        return JSON.parse(cachedRaw) as HotelCachePayload;
      } catch {
        // Corrupt cache — fall through to fresh fetch.
      }
    }
  }

  // Fresh fetch via the provider abstraction.
  const result = await searchHotels({
    env,
    destinationIata,
    destinationCity,
    checkInDate: datePair.checkIn,
    checkOutDate: datePair.checkOut,
    guests,
  });

  // provider_error + we have a stale cache → prefer stale over empty.
  if (result.reason === 'provider_error') {
    const staleRaw = await stub.getCached(cacheKey);
    if (staleRaw) {
      try {
        return JSON.parse(staleRaw) as HotelCachePayload;
      } catch {
        // fall through
      }
    }
  }

  const reason: HotelCachePayload['reason'] =
    result.reason === 'ok' && result.hotels.length === 0
      ? 'no_inventory'
      : result.reason;

  const payload = pkg(reason, result.hotels);

  // Only cache success + empty-result payloads (not transient errors).
  if (payload.reason === 'ok' || payload.reason === 'no_inventory') {
    try {
      await stub.setCached(cacheKey, JSON.stringify(payload), CACHE_TTL_MS);
    } catch (err) {
      console.error('[hotels] could not write cache', err);
    }
  }

  return payload;
}

/**
 * Pull poll_meta.hotel_votes:* + return as a { hotelId: count } map. Best-effort
 * — DO doesn't expose a prefix scan via our existing API, so we read the
 * aggregate JSON blob persisted by /api/hotel-vote (see hotel-vote.ts).
 */
async function getVoteTallies(
  stub: DurableObjectStub<WhenWeGoPollDO>
): Promise<Record<string, number>> {
  const raw = await stub.getMeta('hotel_votes');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw as string) as Record<string, number>;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* fall through */
  }
  return {};
}

export async function handleHotels(
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
    return errorResponse('Not found', 404, req, env);
  }

  let payload: HotelCachePayload;
  try {
    payload = await loadHotelsForPoll({ env, poll });
  } catch (err) {
    console.error('[hotels] unexpected handler error', err);
    const provider = getHotelProvider(env);
    payload = {
      fetchedAt: Date.now(),
      reason: 'provider_error',
      hotels: [],
      destination: { iata: '', city: '' },
      dateRange: { checkIn: '', checkOut: '' },
      guests: poll.participants.length,
      provider: { name: provider.name, isReal: provider.isReal },
    };
  }

  // Pull organiser's choice + per-hotel vote tallies (same DO instance — cheap).
  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
  const [chosenRaw, voteTallies] = await Promise.all([
    stub.getMeta('chosen_hotel'),
    getVoteTallies(stub),
  ]);
  let chosenHotelId: string | undefined;
  if (chosenRaw) {
    try {
      // chosen_hotel is JSON { hotelId, totalPriceEur, name } — see admin-hotel-choose
      const parsed = JSON.parse(chosenRaw as string) as { hotelId?: string };
      if (typeof parsed.hotelId === 'string' && parsed.hotelId) {
        chosenHotelId = parsed.hotelId;
      }
    } catch {
      // Legacy: bare-string chosen hotel id (pre-JSON migration).
      if (typeof chosenRaw === 'string' && chosenRaw.length > 0) {
        chosenHotelId = chosenRaw;
      }
    }
  }

  return jsonResponse(
    {
      fetchedAt: payload.fetchedAt,
      hotels: payload.hotels,
      reason: payload.reason,
      provider: payload.provider,
      destination: payload.destination,
      dateRange: payload.dateRange,
      guests: payload.guests,
      chosenHotelId,
      voteTallies,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
