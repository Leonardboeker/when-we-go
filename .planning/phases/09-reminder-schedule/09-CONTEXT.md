# Phase 9 Context — Reminder Schedule

> Worker cron fires reminder emails at T-30, T-7, T-1, T+1 days relative to the trip start date. Each reminder has its own template + may trigger a re-fetch (T-30 refreshes flight prices, for example).

## Goal

Keep the trip on participants' radar with 4 well-timed emails:
- **T-30** (30 days before trip start): "Trip in a month! Refreshed flight prices. Book yours."
- **T-7** (1 week before): "Trip next week! Weather forecast + activities reminder."
- **T-1** (1 day before): "Tomorrow! Hotel address + map + transit hint."
- **T+1** (1 day after): "Hope it was great. Want to plan another?"

Belt-and-braces with the .ics VALARMs from Phase 8 (which fire device-locally, even if our server is down).

## Decisions

### D-01 — Cron architecture

Reuse the existing hourly cron from Phase 2 (`crons = ["0 * * * *"]` in `wrangler.toml`). No new cron needed.

`scheduled.ts` extended: after the existing auto-close check, add a "check for reminder ticks" pass:

```ts
for (const poll of polls) {
  if (!poll.metaClosed) continue; // only closed polls have a trip date
  const tripStart = parseTripStart(poll); // from overlap_cache
  for (const reminderType of ['T-30', 'T-7', 'T-1', 'T+1'] as const) {
    if (isInReminderWindow(now, tripStart, reminderType)) {
      for (const participant of poll.participants) {
        if (await wasReminderSent(do, participant.token, reminderType)) continue;
        await sendReminderEmail(env, ctx, poll, participant, reminderType);
        await markReminderSent(do, participant.token, reminderType);
      }
    }
  }
}
```

### D-02 — Reminder window math

Cron fires hourly → there's potential for a "missed cron" gap (e.g. CF infrastructure blip, cron skipped). Each reminder window is ±1h around the exact trigger:

| Type | Trigger | Window |
|---|---|---|
| T-30 | tripStart - 30 days | [trigger - 1h, trigger + 1h] |
| T-7 | tripStart - 7 days | same |
| T-1 | tripStart - 1 day | same |
| T+1 | tripStart + 1 day | same |

If cron misses one tick (rare), the next tick catches it within the ±1h window. If it misses MORE than that — accepted edge case, send late or skip silently.

`reminders_sent` table is idempotency guard: never double-send the same (token, type).

### D-03 — Trip start date selection

Closed poll has `overlap_cache` with `{perfect, withEffort, oneShort, ranges}`. Pick:

1. If `overlap.perfect.length > 0` → first date in `overlap.perfect` (sorted ascending)
2. Else if `overlap.withEffort.length > 0` → first date there
3. Else if `overlap.oneShort.length > 0` → first date there
4. Else → no trip, skip reminders (e.g. nobody could agree)

The picked date is cached in `poll_meta.trip_start` (set during `closeNow()` to avoid recomputing every cron tick).

### D-04 — DO schema addition

```sql
CREATE TABLE IF NOT EXISTS reminders_sent (
  token        TEXT NOT NULL,
  type         TEXT NOT NULL,   -- 'T-30' | 'T-7' | 'T-1' | 'T+1'
  sent_at      INTEGER NOT NULL,
  status       TEXT NOT NULL,   -- 'sent' | 'failed' | 'skipped_no_email'
  error        TEXT,
  PRIMARY KEY (token, type)
);
```

DO methods:
- `wasReminderSent(token, type): boolean` — true if status='sent'
- `markReminderSent(token, type, status, error?): void`
- `clearReminders(token?)` — for admin "re-send reminders" feature

### D-05 — Per-reminder templates

`worker/lib/email-templates.ts` extended:

```ts
renderT30Email({poll, participant, profile, flightsRefreshed, hotels}): {subject, html, text}
renderT7Email({poll, participant, profile, weatherForecast?, activities}): {subject, html, text}
renderT1Email({poll, participant, profile, hotel, transitHint}): {subject, html, text}
renderTPlus1Email({poll, participant, profile, hadFun?: boolean}): {subject, html, text}
```

Each shares the header banner + footer with the close-summary email but has type-specific body.

### D-06 — T-30: flight price re-fetch

T-30 specifically triggers `force=true` flight refresh BEFORE rendering the email. Bypasses cache so we get current prices. Compares with last-fetched price + flags changes:

```
✈️ FLIGHTS for you (from Munich MUC) — prices refreshed today
- Lufthansa €119 (was €145 at close — ↓€26 nice!)
- SAS €165 (was €145 — ↑€20)
- EasyJet €89 (unchanged)
```

If price changes are >€50 or >20%, also Telegram-ping the organiser ("flights jumped €60 — Sister might want to book now").

### D-07 — T-7: weather + activities refresher

T-7 fetches a weather forecast for the destination via `https://api.open-meteo.com/v1/forecast` (free, no key). 7-day forecast → embed in email.

Also re-renders the activities list (no API call — uses Phase 7 cache which is 7-day TTL).

### D-08 — T-1: hotel address + transit

T-1 looks up the chosen hotel (from `poll_meta.chosen_hotel` set by organiser in Phase 6, OR falls back to top-of-list).

Includes:
- Hotel name + full address (from Amadeus hotel detail) + Google Maps link
- "Transit to airport" hint — text-only, no real API; just "Most cities have a metro/bus from city center to airport — give yourself 90 min"
- "Check in: Print boarding pass / save to phone wallet"

Optionally, a packing checklist link to a generic page (or just inline 8 items: passport, charger, weather-appropriate clothes, ...).

### D-09 — T+1: wrap-up

Short. "Trip's over. Hope it was great. Want to plan another? Open a new poll: <link>." Maybe a "rate this trip 1-5" prompt for future product feedback (out of MVP scope; just sentiment to organiser).

### D-10 — API surface added

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/admin/send-reminder?slug=X&type=T-7` | organiser | Manually trigger a specific reminder (testing or re-send) |
| GET | `/api/admin/reminder-status?slug=X` | organiser | Per-participant, per-type sent status table |
| POST | `/api/admin/clear-reminders?slug=X&token=Y&type=T-7` | organiser | Clear a single reminder so it re-sends on next cron |

### D-11 — Open-Meteo for weather (T-7 only)

Free, no auth, no rate limit (within reason). Endpoint:

```
GET https://api.open-meteo.com/v1/forecast?
  latitude=55.68&
  longitude=12.57&
  daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&
  forecast_days=7&
  timezone=auto
```

Destination → lat/lon: tiny lookup table `src/data/destinations-geo.json` (~100 cities) OR use Amadeus's city endpoint (already auth'd).

Cache: 6h. Worth re-fetching at T-7; not worth on every page load.

## Cost math

Per 4-person poll, post-close:
- T-30: 4 emails + 4 Amadeus flight refreshes
- T-7: 4 emails + 1 weather call (shared)
- T-1: 4 emails + 1 hotel-detail call
- T+1: 4 emails
- **Total: 16 emails + ~6 API calls** beyond Phase 8

Combined Resend usage per poll = ~24 emails (Phase 8 + Phase 9). Still 125 polls/month within Resend free tier.

## Edge cases

- Poll closed AFTER tripStart somehow (rare, late close) → skip reminders that are in the past
- Cron skips a tick due to CF infra blip → ±1h window covers it; >1h late = miss accepted
- Trip date changes (organiser manually edits `poll_meta.trip_start`) → reminders re-fire from the new date (clear `reminders_sent` rows automatically)
- Participant deletes their email → reminders silently skip + log status `'skipped_no_email'`
- Daylight savings transition during trip → all-day events in .ics are TZ-naive; reminders use UTC math → no DST drift

## What's intentionally NOT in this phase

- SMS reminders via Twilio (cost + complexity, defer)
- Push notifications via web-push API (defer)
- User-configurable reminder schedule (defer — T-30/T-7/T-1/T+1 is the sane default)
- Calendar event auto-update if dates change post-close (defer — re-sending close-summary covers it)
- AI-generated packing list per destination (overkill, generic list is fine)

## Acceptance criteria

1. Closing a poll with `trip_start` 30 days from now → T-30 email fires within the next hour
2. Re-running cron immediately → no duplicate sent (idempotency via `reminders_sent`)
3. Manually advancing `reminders_sent` table to trigger T-7 → T-7 email fires
4. Each reminder email has the right subject + body content + sender info
5. Weather forecast renders in T-7 email (or graceful "couldn't fetch weather" line)
6. T-30 flight refresh actually re-calls Amadeus (verify via log or Amadeus dashboard)
7. Organiser dashboard `/api/admin/reminder-status` shows table: rows = participants, cols = 4 reminder types, cells = sent / pending / skipped
