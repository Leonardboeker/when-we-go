// worker/lib/trip-date.ts
// computeTripStart — pick the canonical trip start date from a closed-poll
// overlap. Cached in poll_meta.trip_start at close-time so the reminder cron
// doesn't have to recompute every tick.
//
// Tier-fallback order (CONTEXT D-03 + safety net):
//   1. overlap.perfect[0]
//   2. overlap.withEffort[0]
//   3. overlap.oneShort[0]
//   4. overlap.ranges[0].start    (catch any range the perDate tiers missed)
//   5. fallback?.dateRangeStart   (no consensus, but poll has a planned range)
//   6. null → no overlap AND no fallback; reminder cron skips this poll

import type { Overlap } from './overlap';
import type { Poll } from './polls-config';

export function computeTripStart(
  overlap: Overlap,
  fallback?: Pick<Poll, 'dateRangeStart'>
): string | null {
  if (overlap.perfect.length > 0) {
    // Phase 2's overlap.perfect/withEffort/oneShort arrays come back in date-
    // ascending order (computeOverlap walks the date range top-down), so
    // index 0 is the earliest viable trip start.
    return overlap.perfect[0];
  }
  if (overlap.withEffort.length > 0) {
    return overlap.withEffort[0];
  }
  if (overlap.oneShort.length > 0) {
    return overlap.oneShort[0];
  }
  if (overlap.ranges.length > 0) {
    return overlap.ranges[0].start;
  }
  // No date-by-date consensus, but if the caller hands us the poll we can
  // still produce a sensible default (the poll's planned start). Better UX
  // than skipping reminders entirely — the organiser can manually adjust by
  // clearing reminders + re-closing later if the trip actually shifts.
  if (fallback?.dateRangeStart) {
    return fallback.dateRangeStart;
  }
  return null;
}
