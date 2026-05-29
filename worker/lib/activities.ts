// worker/lib/activities.ts
// Phase 7 (PROVIDER-ABSTRACTED) — thin orchestration layer above the
// ActivityProvider interface. Mirrors flights.ts / hotels.ts.
//
// Public API:
//   - fetchActivities({env, destination, startDate, endDate, participantCount})
//       → {activities, reason, providerName, providerIsReal} — NEVER throws.
//   - ActivityCachePayload — what we serialise into proposal_cache.
//   - buildActivityCachePayload(...) — helper for callers.
//   - activityCacheKey(...) — shared key builder so handler + cron + email all
//     read/write the same cell.
//
// Reason enum mirrors activity-provider.ts so handlers + UI keep one source.

import type { Env } from '../durable-object';
import { getActivityProvider } from './activity-provider.ts';
import type {
  ActivityList,
  ActivityReason,
} from './activity-provider.ts';

export type { ActivityItem, ActivityList, ActivityReason } from './activity-provider.ts';

export interface FetchActivitiesArgs {
  env: Env;
  destination: string;
  /** ISO YYYY-MM-DD inclusive. */
  startDate: string;
  /** ISO YYYY-MM-DD inclusive. */
  endDate: string;
  participantCount: number;
}

export interface FetchActivitiesResult {
  activities: ActivityList;
  reason: ActivityReason;
  providerName: string;
  providerIsReal: boolean;
}

/**
 * Main entrypoint. Resolves to {activities, reason, providerName, providerIsReal}
 * — NEVER throws. Wraps provider.fetchActivities in a try/catch so a provider
 * blow-up downgrades to `reason: 'provider_error'` instead of a 500.
 */
export async function fetchActivities(
  args: FetchActivitiesArgs
): Promise<FetchActivitiesResult> {
  const provider = getActivityProvider(args.env);

  if (!args.destination) {
    return {
      activities: { thisWeek: [], alwaysGreat: [] },
      reason: 'destination_too_obscure',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }

  try {
    const result = await provider.fetchActivities({
      destination: args.destination,
      startDate: args.startDate,
      endDate: args.endDate,
      participantCount: args.participantCount,
    });
    return {
      activities: result.activities,
      reason: result.reason,
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  } catch (err) {
    console.error(
      `[activities] provider ${provider.name} threw: ${
        err instanceof Error ? err.message : err
      }`
    );
    return {
      activities: { thisWeek: [], alwaysGreat: [] },
      reason: 'provider_error',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }
}

/**
 * Cache shape stored in DO proposal_cache. One key per (slug, dates,
 * provider) — activities are shared across the poll (not per-participant).
 */
export interface ActivityCachePayload {
  fetchedAt: number;
  reason: ActivityReason;
  activities: ActivityList;
  destination: string;
  dateRange: { start: string; end: string };
  /** Provider attribution for the UI (DEMO banner) + cache-key stability. */
  provider: { name: string; isReal: boolean };
}

export function buildActivityCachePayload(args: {
  reason: ActivityReason;
  activities: ActivityList;
  destination: string;
  dateRange: { start: string; end: string };
  provider: { name: string; isReal: boolean };
}): ActivityCachePayload {
  return {
    fetchedAt: Date.now(),
    reason: args.reason,
    activities: args.activities,
    destination: args.destination,
    dateRange: args.dateRange,
    provider: args.provider,
  };
}

/**
 * Build the cache key. Includes provider name so swapping mock → real cleanly
 * invalidates the previous cell (no risk of serving stale mock data after the
 * Anthropic key lands).
 */
export function activityCacheKey(
  slug: string,
  dateRange: { start: string; end: string } | null,
  providerName: string
): string {
  if (!dateRange) return `activities:${slug}:nodate:${providerName}`;
  return `activities:${slug}:${dateRange.start}:${dateRange.end}:${providerName}`;
}
