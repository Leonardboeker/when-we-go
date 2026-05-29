// worker/handlers/flights-refresh.ts
// Phase 5 — POST /api/flights/refresh?slug=X&token=Y
//
// Force-refresh flights for a single participant. Bypasses the 24h cache but
// rate-limited to 1 refresh per hour per (slug, token) to keep Amadeus quota
// safe.
//
// Rate-limit state stored in DO poll_meta under `flights_refresh_at:<token>`
// (unix ms of last successful refresh). Within the 1-hour window we return
// 429 with a `retryAfterMs` field — frontend can hide the button or show a
// countdown.
//
// Always returns the same payload shape as GET /api/flights so the UI can
// re-use its rendering path with the fresh data.

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateParticipantToken } from '../lib/polls-config';
import { loadFlightsForParticipant } from './flights';
import { cityForIata } from '../lib/destinations';

const REFRESH_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function handleFlightsRefresh(
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

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const rateKey = `flights_refresh_at:${token}`;
  const lastRaw = await stub.getMeta(rateKey);
  const lastMs = lastRaw ? parseInt(lastRaw as string, 10) : 0;
  const now = Date.now();
  const elapsed = now - lastMs;
  if (lastMs > 0 && elapsed < REFRESH_WINDOW_MS) {
    return jsonResponse(
      {
        ok: false,
        error: 'Refresh rate-limited — try again later',
        retryAfterMs: REFRESH_WINDOW_MS - elapsed,
      },
      { status: 429 },
      req,
      env
    );
  }

  // Record the attempt FIRST so a burst of clicks doesn't all sneak through
  // before the API call returns.
  await stub.setMeta(rateKey, String(now));

  const payload = await loadFlightsForParticipant({
    env,
    poll,
    token,
    forceRefresh: true,
  });

  return jsonResponse(
    {
      ok: true,
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
