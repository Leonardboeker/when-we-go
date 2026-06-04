// worker/handlers/activities.ts
// Phase 7 — Activity Suggestions.
//
// Routes:
//   GET  /api/activities?slug=X&token=Y  — any valid participant token
//   POST /api/activities/refresh?slug=X  — organiser-gated (X-Organizer-Token header), 1/day
//
// Both routes delegate to `loadActivitiesForPoll()` which is also imported by
// scheduled.ts for on-close pre-fetch.

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateParticipantToken, validateOrganizerToken, type Poll } from '../lib/polls-config';
import {
  fetchActivitiesFromClaude,
  activitiesCacheKey,
  activitiesRefreshLockKey,
  type ActivitiesCachePayload,
} from '../lib/activities';
import type { Overlap } from '../lib/overlap';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days (D-03)
const REFRESH_LOCK_TTL_MS = 24 * 60 * 60 * 1000; // 1 day rate-limit (D-04)

/** Resolve the best available date pair from overlap or fall back to poll window. */
function resolveDatePair(
  poll: Poll,
  overlap: Overlap | null
): { start: string; end: string } | null {
  const featured = overlap?.ranges?.[0] ?? null;
  if (featured) return { start: featured.start, end: featured.end };
  if (poll.dateRangeStart && poll.dateRangeEnd) {
    return { start: poll.dateRangeStart, end: poll.dateRangeEnd };
  }
  return null;
}

/**
 * Shared core: returns an ActivitiesCachePayload from cache or fresh Claude call.
 * Used by both the participant GET handler and scheduled.ts on-close prefetch.
 */
export async function loadActivitiesForPoll(args: {
  env: Env;
  poll: Poll;
  forceRefresh?: boolean;
}): Promise<ActivitiesCachePayload> {
  const { env, poll, forceRefresh = false } = args;

  const apiKey = env.WHENWEGO_ANTHROPIC_API_KEY;
  const destination = poll.destination ?? poll.title ?? '';
  const participantCount = poll.participants.length;

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(poll.slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // Resolve trip dates from overlap cache.
  const overlapRaw = await stub.getMeta('overlap_cache');
  let overlap: Overlap | null = null;
  if (overlapRaw) {
    try { overlap = JSON.parse(overlapRaw as string) as Overlap; } catch { /* ignore */ }
  }
  const datePair = resolveDatePair(poll, overlap);

  const empty = (reason: ActivitiesCachePayload['reason']): ActivitiesCachePayload => ({
    fetchedAt: Date.now(),
    reason,
    thisWeek: [],
    alwaysGreat: [],
    destination,
    dateRange: { start: datePair?.start ?? '', end: datePair?.end ?? '' },
  });

  // Missing API key → return early with 'not_configured' (D-07).
  if (!apiKey) return empty('not_configured');

  const cacheKey = activitiesCacheKey(poll.slug);

  // Cache read (skip when forceRefresh).
  if (!forceRefresh) {
    const cachedRaw = await stub.getCached(cacheKey);
    if (cachedRaw) {
      try { return JSON.parse(cachedRaw) as ActivitiesCachePayload; } catch { /* corrupt, fall through */ }
    }
  }

  // Fresh Claude API call.
  const { result, reason } = await fetchActivitiesFromClaude({
    apiKey,
    destination,
    dateStart: datePair?.start ?? poll.dateRangeStart,
    dateEnd: datePair?.end ?? poll.dateRangeEnd,
    participantCount,
  });

  // On API error: return stale cache if available, else empty.
  if (reason !== 'ok' || !result) {
    const staleRaw = await stub.getCached(cacheKey);
    if (staleRaw) {
      try { return JSON.parse(staleRaw) as ActivitiesCachePayload; } catch { /* corrupt */ }
    }
    return empty(reason);
  }

  const payload: ActivitiesCachePayload = {
    fetchedAt: Date.now(),
    reason: 'ok',
    thisWeek: result.thisWeek,
    alwaysGreat: result.alwaysGreat,
    destination,
    dateRange: { start: datePair?.start ?? '', end: datePair?.end ?? '' },
  };

  // Persist to proposal_cache (7d TTL).
  try {
    await stub.setCached(cacheKey, JSON.stringify(payload), CACHE_TTL_MS);
  } catch (err) {
    console.error('[activities] cache write failed', err);
  }

  return payload;
}

// ─── GET /api/activities ──────────────────────────────────────────────────

export async function handleActivities(
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
  if (!poll) return errorResponse('Not found', 404, req, env);

  if (!validateParticipantToken(poll, token)) {
    return errorResponse('Not found', 404, req, env);
  }

  let payload: ActivitiesCachePayload;
  try {
    payload = await loadActivitiesForPoll({ env, poll });
  } catch (err) {
    console.error('[activities] unexpected GET error', err);
    payload = {
      fetchedAt: Date.now(),
      reason: 'api_down',
      thisWeek: [],
      alwaysGreat: [],
      destination: poll.destination ?? '',
      dateRange: { start: '', end: '' },
    };
  }

  return jsonResponse(payload, { status: 200, headers: { 'Cache-Control': 'no-store' } }, req, env);
}

// ─── POST /api/activities/refresh ─────────────────────────────────────────

export async function handleActivitiesRefresh(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) return errorResponse('Missing slug', 400, req, env);

  const poll = findPoll(env, slug);
  if (!poll) return errorResponse('Not found', 404, req, env);

  if (!validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // Rate-limit: 1 refresh per day.
  const lockKey = activitiesRefreshLockKey(slug);
  const locked = await stub.getCached(lockKey);
  if (locked) {
    return jsonResponse(
      { ok: false, error: 'Rate limit — activities can be refreshed once per day.' },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
      req,
      env
    );
  }

  let payload: ActivitiesCachePayload;
  try {
    payload = await loadActivitiesForPoll({ env, poll, forceRefresh: true });
    // Set refresh lock after a successful call.
    await stub.setCached(lockKey, '1', REFRESH_LOCK_TTL_MS);
  } catch (err) {
    console.error('[activities] unexpected refresh error', err);
    return errorResponse('Refresh failed', 500, req, env);
  }

  return jsonResponse(payload, { status: 200, headers: { 'Cache-Control': 'no-store' } }, req, env);
}
