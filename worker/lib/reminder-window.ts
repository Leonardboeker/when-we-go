// worker/lib/reminder-window.ts
// Pure window-math for reminder cron. Given a `now` timestamp and a trip-start
// ISO date, decide whether each reminder type is currently in its ±1h trigger
// window.
//
// Why ±1h: the cron fires hourly (`0 * * * *`). A reminder is "due" at exactly
// tripStart − Nd. If cron misses one tick (CF infra blip), the NEXT tick still
// falls inside the trigger ± 1h envelope and the email goes out one hour late.
// If cron misses more than that, we accept the loss (not worth complicating
// for sub-1%-likelihood gaps).
//
// All math is UTC; trip-start dates are interpreted as midnight UTC. We use
// integer ms arithmetic instead of Date arithmetic to dodge any DST surprises
// (a literal `tripStart - 30 * 24 * 3600_000` is identical regardless of
// whether DST flipped in between).

import type { ReminderType } from '../durable-object';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_HALF_MS = HOUR_MS; // ±1h envelope around the trigger
// Berlin-friendly time-of-day for reminder emails. The trip-start ISO is
// interpreted as midnight UTC; adding this offset moves the trigger to 10:00
// Berlin (CEST=+02:00 -> 08:00 UTC; CET=+01:00 -> 09:00 UTC). 8h is a deliberate
// middle-ground so Papa sees the email at breakfast in both seasons, never at
// 03:00. UI/email copy stays "30 days before / 1 day before"; the small
// drift inside the day is invisible to recipients.
const BERLIN_BREAKFAST_OFFSET_MS = 8 * HOUR_MS;

const OFFSET_DAYS: Record<ReminderType, number> = {
  'T-30': -30,
  'T-7': -7,
  'T-1': -1,
  'T+1': +1,
};

/** Parse `YYYY-MM-DD` as midnight-UTC ms. Returns NaN on malformed input. */
function parseTripStartMs(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return NaN;
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Trigger time (ms) for a given type — exposed for tests + introspection. */
export function reminderTriggerMs(
  tripStartIso: string,
  type: ReminderType
): number {
  const start = parseTripStartMs(tripStartIso);
  if (Number.isNaN(start)) return NaN;
  return start + OFFSET_DAYS[type] * DAY_MS + BERLIN_BREAKFAST_OFFSET_MS;
}

/**
 * Returns true when `now` is within ±1h of the type's trigger.
 *
 * Invariants:
 *   - Unknown reminder types: false (defensive — cron never iterates outside
 *     the literal union but defending here keeps callers safe).
 *   - Malformed tripStartIso: false (we never want to fire emails on garbage).
 */
export function isInReminderWindow(
  now: number,
  tripStartIso: string,
  type: ReminderType
): boolean {
  if (!(type in OFFSET_DAYS)) return false;
  const trigger = reminderTriggerMs(tripStartIso, type);
  if (Number.isNaN(trigger)) return false;
  const delta = now - trigger;
  return delta >= -WINDOW_HALF_MS && delta <= WINDOW_HALF_MS;
}
