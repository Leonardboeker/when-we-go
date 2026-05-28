# Phase 9 Plan — Reminder Schedule

> Cron-driven T-30 / T-7 / T-1 / T+1 reminder emails. Extends Phase 8 infrastructure.
> All paths relative to `D:/dev/when-we-go/`. Real Resend key in `.dev.vars`.

## Tasks

### T-01 — DO schema: reminders_sent
**Files:** `worker/durable-object.ts` (extend SCHEMA_DDL)

```sql
CREATE TABLE IF NOT EXISTS reminders_sent (
  token        TEXT NOT NULL,
  type         TEXT NOT NULL,    -- 'T-30' | 'T-7' | 'T-1' | 'T+1'
  sent_at      INTEGER NOT NULL,
  status       TEXT NOT NULL,    -- 'sent' | 'failed' | 'skipped_no_email'
  error        TEXT,
  PRIMARY KEY (token, type)
);
```

DO methods:
- `wasReminderSent(token, type): boolean` — true if any row exists with status='sent'
- `markReminderSent(token, type, status, error?): void`
- `getReminderStatus(): Array<{token, type, sent_at, status}>` — for admin endpoint
- `clearReminder(token, type): void` — admin force-resend support

### T-02 — Trip-start helper
**Files:** `worker/lib/trip-date.ts` (new)

`computeTripStart(overlap: Overlap): string | null` per CONTEXT D-03:
- If `overlap.perfect.length > 0` → first date
- Else if `withEffort.length > 0` → first date
- Else if `oneShort.length > 0` → first date
- Else null (no viable trip — skip reminders)

Cache it during `closeNow()` as `poll_meta.trip_start` to avoid recomputing each cron tick.

### T-03 — Open-Meteo weather fetch
**Files:** `worker/lib/weather.ts` (new)

`getForecast(destLat, destLon, days=7): Forecast | null`. Free API, no key. URL:

```
https://api.open-meteo.com/v1/forecast?
  latitude=<lat>&longitude=<lon>&
  daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&
  forecast_days=<days>&timezone=auto
```

Returns `{daily: [{date, tempMax, tempMin, code, precipProb}]}`. Cache 6h.

Destination → lat/lon lookup: `src/data/destinations-geo.json` (new, ~100 cities; e.g. Copenhagen → 55.68, 12.57). Source: hand-curated from Wikipedia.

### T-04 — Reminder window math
**Files:** `worker/lib/reminder-window.ts` (new)

`isInReminderWindow(now: number, tripStart: string, type: 'T-30'|'T-7'|'T-1'|'T+1'): boolean`:
- T-30 trigger = tripStart minus 30 days (in ms)
- ±1h window around trigger
- T+1 = tripStart plus 1 day

Pure function, unit-test it (T-05).

### T-05 — Reminder window unit tests
**Files:** `worker/lib/reminder-window.test.ts`

≥ 6 assertions:
- T-30 fires when now = tripStart - 30 days exact
- T-30 fires when now within ±1h
- T-30 NOT fires when now = tripStart - 30 days - 2h
- T+1 fires correctly past tripStart
- Stable across DST boundary
- Returns false for unknown type

### T-06 — Email templates per reminder
**Files:** `worker/lib/email-templates.ts` (extend)

Export 4 new render functions:
- `renderT30Email({poll, participant, profile, overlap, flightsRefreshed?, hotels?, siteUrl})` 
- `renderT7Email({poll, participant, profile, overlap, weatherForecast?, activities?, siteUrl})` 
- `renderT1Email({poll, participant, profile, overlap, chosenHotel?, siteUrl})` 
- `renderTPlus1Email({poll, participant, profile, siteUrl})` 

Each returns `{subject, html, text}` (no .ics attachment — only close-summary attaches that).

Subject lines:
- `🗓 ${destination} in 1 month — refreshed details`
- `🎒 ${destination} next week — quick checklist`
- `✈️ ${destination} tomorrow!`
- `Hope ${destination} was great. Want to plan another?`

Template style: same header banner + footer pattern as close-summary; body varies per type.

### T-07 — Reminder fan-out
**Files:** `worker/lib/reminder-fanout.ts` (new)

`async function fanOutReminders(env, poll, type, ctx)`:
1. Open DO stub for `poll.slug`
2. Check `isClosed()` — skip if not closed (no trip)
3. Read `poll_meta.trip_start` — skip if null
4. For each participant:
   - Check `wasReminderSent(token, type)` — skip if true
   - Get `profile = getProfile(token)` — if no email, `markReminderSent(token, type, 'skipped_no_email')` + continue
   - For T-30: re-fetch Phase 5 flights with force=true (when Phase 5 ships; for now, pass empty)
   - For T-7: fetch weather via getForecast
   - Build email via the right `renderXxxEmail`
   - `await sendResendEmail(...)` (await this one — we want the status for `markReminderSent`)
   - `markReminderSent(token, type, ok ? 'sent' : 'failed', error)`

Fire from `ctx.waitUntil` at the cron level so the cron handler doesn't block.

### T-08 — Cron extension
**Files:** `worker/scheduled.ts`

After existing close-check loop, add reminder-check loop:
```ts
for (const poll of polls) {
  // ... existing close-check
  // New:
  const tripStart = await stub.getMeta('trip_start');
  if (!tripStart) continue;
  for (const type of ['T-30', 'T-7', 'T-1', 'T+1'] as const) {
    if (isInReminderWindow(Date.now(), tripStart, type)) {
      ctx.waitUntil(fanOutReminders(env, poll, type, ctx).catch(...));
    }
  }
}
```

### T-09 — Admin endpoints
**Files:** 
- `worker/handlers/admin-reminders.ts` (new) — `GET /api/admin/reminder-status?slug=X`
- `worker/handlers/admin-send-reminder.ts` (new) — `POST /api/admin/send-reminder?slug=X&type=T-7`
- `worker/handlers/admin-clear-reminder.ts` (new) — `POST /api/admin/clear-reminder?slug=X&token=Y&type=T-7`

All organiser-token-gated (404 on wrong token). Reuse Phase 8 fan-out helper.

### T-10 — Update close-flow to set trip_start
**Files:** `worker/scheduled.ts`, `worker/handlers/admin-close.ts`, `worker/lib/close-email-fanout.ts`

After `closeNow(overlapJson)`, also call `stub.setMeta('trip_start', computeTripStart(overlap) ?? '')`. The empty-string case means "no viable trip" → reminder cron will see empty and skip.

### T-11 — Smoke test extension
**Files:** `scripts/smoke-test.mjs`

Add:
- `GET /api/admin/reminder-status?slug=X` with org token → 200 + `{status: [...]}`
- `GET /api/admin/reminder-status` with wrong org → 404
- `POST /api/admin/send-reminder?slug=X&type=T-7` → 200 (or skipped_no_email if profiles empty)
- `POST /api/admin/clear-reminder?slug=X&token=Y&type=T-7` → 200
- Verify after force-send: a `reminders_sent` row exists with correct status

### T-12 — Build verify + smoke
1. `npm run build` → still 7+ pages
2. `verify-isolation` → exit 0
3. `node --test worker/lib/overlap.test.ts` → 8/8
4. `node --test worker/lib/ical.test.ts` → 8/8
5. `node --test worker/lib/reminder-window.test.ts` → ≥6 pass
6. `wrangler deploy --dry-run` → clean compile
7. `wrangler dev` + smoke → 25 existing + ~5 new pass = 30+/30+

## Acceptance

- Closing a poll sets `poll_meta.trip_start`
- Manually firing `POST /api/admin/send-reminder?type=T-7` triggers email send for participants with profiles
- Reminder is idempotent: re-firing the same type without clearing → no duplicate email
- `clear-reminder` allows force-resend
- Weather forecast embeds in T-7 email (or graceful "couldn't fetch")
- T-30 / T-1 emails render even with empty flights (Phase 5 fills later)
- Phase 8 + 4 + earlier smoke tests still green
- Real Resend integration verified (HTTP 403 sandbox is OK, treated as "sent")
