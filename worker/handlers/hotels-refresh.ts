// worker/handlers/hotels-refresh.ts
// Phase 6 — POST /api/hotels/refresh?slug=X
//
// Organiser-only force-refresh of the shared hotel shortlist. Bypasses the 24h
// cache but rate-limited to 1 refresh per 4 hours per slug to keep real-provider
// quota safe.
//
// Rate-limit state stored in DO poll_meta under `hotels_refresh_at` (unix ms of
// last successful refresh). Within the 4-hour window we return 429 with a
// `retryAfterMs` field so the admin UI can hide the button or show a countdown.
//
// Auth: X-Organizer-Token header. Wrong/missing → 404.

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { loadHotelsForPoll } from './hotels';

const REFRESH_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours per CONTEXT D-03

export async function handleHotelsRefresh(
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

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const rateKey = 'hotels_refresh_at';
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
  // before the provider call returns.
  await stub.setMeta(rateKey, String(now));

  const payload = await loadHotelsForPoll({ env, poll, forceRefresh: true });

  return jsonResponse(
    {
      ok: true,
      fetchedAt: payload.fetchedAt,
      hotels: payload.hotels,
      reason: payload.reason,
      provider: payload.provider,
      destination: payload.destination,
      dateRange: payload.dateRange,
      guests: payload.guests,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
