---
phase: 09-reminder-schedule
plan: 01
subsystem: "reminders"
tags: ["worker", "cron", "email"]
provides: ["reminder-emails"]
affects: ["cron", "admin-close", "durable-object"]
tech-stack:
  added: ["reminder-window.ts (±1h cron window calc)", "weather.ts (T-7 forecast)", "destinations-geo.json"]
  patterns: ["reminders_sent idempotency table in DO", "fanOutReminders()"]
key-files:
  created:
    - worker/lib/reminder-fanout.ts
    - worker/lib/reminder-window.ts
    - worker/lib/reminder-window.test.ts
    - worker/lib/trip-date.ts
    - worker/lib/weather.ts
    - worker/handlers/admin-reminders.ts
    - worker/handlers/admin-send-reminder.ts
    - worker/handlers/admin-clear-reminder.ts
    - src/data/destinations-geo.json
  modified:
    - worker/durable-object.ts
    - worker/handlers/admin-close.ts
    - worker/index.ts
    - worker/lib/close-email-fanout.ts
    - worker/lib/email-templates.ts
    - worker/scheduled.ts
    - .env.example
key-decisions:
  - "±1h cron window prevents missed sends if cron briefly down"
  - "reminders_sent table in DO for idempotency — double-send impossible"
  - "T-30 re-fetches Amadeus/Kiwi flights (prices may have changed)"
  - "T-7 includes weather forecast for destination"
  - "trip_start stored in poll_meta on close so cron loop doesn't recompute"
patterns-established:
  - "isInReminderWindow() pure function, unit-tested"
duration: "1 day"
completed: 2026-05-28
---

# Phase 9: Reminder Schedule Summary

**Hourly cron fires T-30/T-7/T-1/T+1 reminder emails per participant. Idempotency via reminders_sent DO table. T-30 refreshes flight prices. T-7 includes weather forecast.**

## Accomplishments

- fanOutReminders() — per-type, per-participant, idempotent
- isInReminderWindow() — ±1h window around trip_start - N days
- reminders_sent DO table prevents double-sends
- GET /api/admin/reminder-status — per-participant per-type status
- POST /api/admin/send-reminder — organiser force-fire
- POST /api/admin/clear-reminder — reset to allow re-send
- weather.ts — best-effort T-7 forecast via wttr.in (no API key needed)

## Next Phase Readiness

Email + reminders complete. Cost data + pay-me-back export (Phase 10) is independent.
