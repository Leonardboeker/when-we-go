// worker/lib/reminder-window.test.ts
// node --test compatible unit tests for reminder-window. Run via:
//   node --test worker/lib/reminder-window.test.ts
//
// These tests are correctness-critical: the hourly cron derives its "should I
// fire this email?" decision exclusively from isInReminderWindow. A bug here
// either spams participants (over-firing) or silently drops reminders
// (under-firing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInReminderWindow,
  reminderTriggerMs,
} from './reminder-window.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Anchor: a known trip start. Date.UTC is the source of truth.
const TRIP_START_ISO = '2026-07-12';
const TRIP_START_MS = Date.UTC(2026, 6, 12); // July is month 6 (0-indexed)

test('T-30 fires when now = tripStart - 30 days exactly', () => {
  const now = TRIP_START_MS - 30 * DAY_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-30'), true);
});

test('T-30 fires within +1h of trigger', () => {
  const now = TRIP_START_MS - 30 * DAY_MS + (HOUR_MS - 1);
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-30'), true);
});

test('T-30 fires within -1h of trigger', () => {
  const now = TRIP_START_MS - 30 * DAY_MS - (HOUR_MS - 1);
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-30'), true);
});

test('T-30 does NOT fire when now = tripStart - 30 days - 2h (outside window)', () => {
  const now = TRIP_START_MS - 30 * DAY_MS - 2 * HOUR_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-30'), false);
});

test('T-30 does NOT fire 7 days before trip (way past window)', () => {
  const now = TRIP_START_MS - 7 * DAY_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-30'), false);
});

test('T-7 fires exactly 7 days before trip', () => {
  const now = TRIP_START_MS - 7 * DAY_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-7'), true);
});

test('T-1 fires exactly 1 day before trip', () => {
  const now = TRIP_START_MS - DAY_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T-1'), true);
});

test('T+1 fires exactly 1 day after trip start', () => {
  const now = TRIP_START_MS + DAY_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T+1'), true);
});

test('T+1 does NOT fire on trip start day', () => {
  const now = TRIP_START_MS;
  assert.equal(isInReminderWindow(now, TRIP_START_ISO, 'T+1'), false);
});

test('stable across DST boundary — March 29 2026 (Europe/Berlin spring-forward)', () => {
  // Trip starts on the day a DST transition would happen if we used local
  // time. Confirm UTC math ignores that — we still fire at exactly tripStart
  // - 1 day in pure UTC ms.
  const dstTripIso = '2026-03-29';
  const dstTripMs = Date.UTC(2026, 2, 29); // March, day 29
  const now = dstTripMs - DAY_MS;
  assert.equal(isInReminderWindow(now, dstTripIso, 'T-1'), true);
  // Off by exactly 23h shouldn't matter — still inside ±1h window only if
  // delta ≤ HOUR_MS; here delta is -1h relative to trigger so it's exactly
  // on the edge but inclusive (HOUR_MS).
  const at23h = dstTripMs - DAY_MS - HOUR_MS;
  assert.equal(isInReminderWindow(at23h, dstTripIso, 'T-1'), true);
});

test('returns false for malformed tripStart (defensive)', () => {
  // @ts-expect-error — defensive runtime check
  assert.equal(isInReminderWindow(Date.now(), 'not-a-date', 'T-7'), false);
  // @ts-expect-error — empty string
  assert.equal(isInReminderWindow(Date.now(), '', 'T-7'), false);
});

test('returns false for unknown reminder type (defensive)', () => {
  // @ts-expect-error — defensive runtime check against unknown literals
  assert.equal(isInReminderWindow(TRIP_START_MS, TRIP_START_ISO, 'T-99'), false);
});

test('reminderTriggerMs computes correct epoch ms for each type', () => {
  assert.equal(
    reminderTriggerMs(TRIP_START_ISO, 'T-30'),
    TRIP_START_MS - 30 * DAY_MS
  );
  assert.equal(
    reminderTriggerMs(TRIP_START_ISO, 'T-7'),
    TRIP_START_MS - 7 * DAY_MS
  );
  assert.equal(
    reminderTriggerMs(TRIP_START_ISO, 'T-1'),
    TRIP_START_MS - DAY_MS
  );
  assert.equal(
    reminderTriggerMs(TRIP_START_ISO, 'T+1'),
    TRIP_START_MS + DAY_MS
  );
});
