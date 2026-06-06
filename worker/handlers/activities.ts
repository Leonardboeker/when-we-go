// worker/handlers/activities.ts
// Phase 7 — GET /api/activities?slug=X&token=Y
//
// Shared curated activity list for the destination + dates. Cache-first: if
// proposal_cache has fresh data for this (slug, dateRange, provider) tuple,
// return it; otherwise call the configured provider, store, return.
// Cache TTL: 7 days (activities are slow-moving — D-03).
//
// Auth: any valid participant token. Wrong token → 404.
//
// Always 200 (unless slug/token bad) — graceful reasons in the body so the
// frontend can render a friendly state:
//   'ok'                       — activities populated
//   'destination_too_obscure'  — provider returned empty (rare for Claude)
//   'not_configured'           — no Anthropic key AND no mock fallback (shouldn't happen)
//   'provider_error'           — provider blew up; returns stale cache if any

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import {
  findPoll,
  validateParticipantToken,
  type Poll,
} from '../lib/polls-config';
import {
  fetchActivities,
  buildActivityCachePayload,
  activityCacheKey,
  type ActivityCachePayload,
} from '../lib/activities';
import { getActivityProvider } from '../lib/activity-provider';
import { geocodeDestination } from '../lib/activity-provider-wikimedia';
import { fetchTicketmasterEvents } from '../lib/event-provider-ticketmaster';
import type { ActivityItem } from '../lib/activity-provider';
import type { Overlap } from '../lib/overlap';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days per CONTEXT D-03

/**
 * Resolve start/end from the closed-overlap (preferred) or fall back to the
 * raw poll window. Activity provider expects ISO YYYY-MM-DD inclusive.
 */
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
 * Shared core used by both the participant GET and the cron pre-fetch. Returns
 * the cached payload shape (no Response wrapping — caller decides).
 *
 * `forceRefresh` skips the cache read but still writes the fresh result.
 */
export async function loadActivitiesForPoll(args: {
  env: Env;
  poll: Poll;
  forceRefresh?: boolean;
}): Promise<ActivityCachePayload> {
  const { env, poll, forceRefresh = false } = args;
  const provider = getActivityProvider(env);
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

  const destination = poll.destination ?? poll.title ?? '';
  const datePair = resolveDatePair(poll, overlap);
  const participantCount = poll.participants.length;

  const cacheKey = activityCacheKey(poll.slug, datePair, provider.name);

  const pkg = (
    reason: ActivityCachePayload['reason'],
    activities: ActivityCachePayload['activities']
  ): ActivityCachePayload =>
    buildActivityCachePayload({
      reason,
      activities,
      destination,
      dateRange: {
        start: datePair?.start ?? '',
        end: datePair?.end ?? '',
      },
      provider: providerInfo,
    });

  if (!destination) {
    return pkg('destination_too_obscure', { thisWeek: [], alwaysGreat: [] });
  }
  if (!datePair) {
    return pkg('destination_too_obscure', { thisWeek: [], alwaysGreat: [] });
  }

  // Cache check (unless forced).
  if (!forceRefresh) {
    const cachedRaw = await stub.getCached(cacheKey);
    if (cachedRaw) {
      try {
        return JSON.parse(cachedRaw) as ActivityCachePayload;
      } catch {
        // Corrupt cache — fall through to fresh fetch.
      }
    }
  }

  // Fresh fetch via the provider abstraction.
  const result = await fetchActivities({
    env,
    destination,
    startDate: datePair.start,
    endDate: datePair.end,
    participantCount,
  });

  // provider_error + we have a stale cache → prefer stale over empty.
  if (result.reason === 'provider_error') {
    const staleRaw = await stub.getCached(cacheKey);
    if (staleRaw) {
      try {
        return JSON.parse(staleRaw) as ActivityCachePayload;
      } catch {
        // fall through
      }
    }
  }

  // ── Dated events (Ticketmaster) → thisWeek ────────────────────────────────
  // The Wikimedia provider only fills `alwaysGreat` (evergreen sights). Layer
  // the real, date-bound events that happen DURING the trip window on top as
  // `thisWeek`. We reuse the SAME destination→coords resolution the Wikimedia
  // path uses (geocodeDestination) so we don't geocode twice, and pass the
  // resolved overlap/poll trip dates. Fully graceful: no key or any error →
  // events is [] and thisWeek just stays empty (alwaysGreat still shows).
  let events: ActivityItem[] = [];
  if (env.WHENWEGO_TICKETMASTER_API_KEY) {
    try {
      const geo = await geocodeDestination(destination);
      if (geo) {
        events = await fetchTicketmasterEvents(
          env,
          geo.lat,
          geo.lng,
          datePair.start,
          datePair.end
        );
      }
    } catch (err) {
      // fetchTicketmasterEvents never throws, but geocodeDestination could —
      // swallow so the activities page is never broken by the events layer.
      console.error('[activities] ticketmaster events failed', err);
      events = [];
    }
  }

  // Merge: events become thisWeek, Wikimedia sights stay alwaysGreat. When the
  // attractions provider errored but events succeeded, still surface the events
  // (and flip the reason to 'ok' so the UI renders them instead of an error).
  const mergedActivities = {
    thisWeek: events,
    alwaysGreat: result.activities.alwaysGreat ?? [],
  };
  const mergedReason =
    result.reason !== 'ok' && events.length > 0 ? 'ok' : result.reason;

  const payload = pkg(mergedReason, mergedActivities);

  // Only cache success payloads. Don't lock in provider_error or
  // destination_too_obscure — re-try next call.
  if (payload.reason === 'ok') {
    try {
      await stub.setCached(cacheKey, JSON.stringify(payload), CACHE_TTL_MS);
    } catch (err) {
      console.error('[activities] could not write cache', err);
    }
  }

  return payload;
}

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
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }
  const participant = validateParticipantToken(poll, token);
  if (!participant) {
    return errorResponse('Not found', 404, req, env);
  }

  let payload: ActivityCachePayload;
  try {
    payload = await loadActivitiesForPoll({ env, poll });
  } catch (err) {
    console.error('[activities] unexpected handler error', err);
    const provider = getActivityProvider(env);
    payload = {
      fetchedAt: Date.now(),
      reason: 'provider_error',
      activities: { thisWeek: [], alwaysGreat: [] },
      destination: poll.destination ?? poll.title ?? '',
      dateRange: { start: '', end: '' },
      provider: { name: provider.name, isReal: provider.isReal },
    };
  }

  return jsonResponse(
    {
      fetchedAt: payload.fetchedAt,
      activities: payload.activities,
      reason: payload.reason,
      provider: payload.provider,
      destination: payload.destination,
      dateRange: payload.dateRange,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
