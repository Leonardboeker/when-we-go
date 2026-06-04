---
phase: 08-email-and-ical
plan: 01
subsystem: "email"
tags: ["worker", "resend", "ical", "rfc-5545"]
provides: ["close-summary-email", "ical-calendar-invite"]
affects: ["close-fanout", "admin-close", "participant-page"]
tech-stack:
  added: ["Resend.com email API", "iCal RFC 5545 generation", "Satori OG images already present"]
  patterns: ["renderCloseSummaryEmail()", "buildICalForPoll()", "add-to-calendar URL builders"]
key-files:
  created:
    - worker/lib/resend.ts
    - worker/lib/email-templates.ts
    - worker/lib/ical.ts
    - worker/lib/ical.test.ts
    - worker/lib/calendar-links.ts
    - worker/lib/close-email-fanout.ts
    - worker/handlers/ical.ts
    - worker/handlers/admin-resend-summary.ts
    - src/components/EmailButtons.astro
    - src/lib/calendar-links.ts
  modified:
    - worker/durable-object.ts
    - worker/handlers/admin-close.ts
    - worker/index.ts
    - worker/scheduled.ts
    - src/pages/[slug]/[token].astro
    - .env.example
key-decisions:
  - "Fire-and-forget via ctx.waitUntil — close response not blocked by email sends"
  - "Participant with no email silently skipped (Telegram-only mode)"
  - "VALARM reminders at -30d/-7d/-1d/-2h baked into .ics"
  - "Add-to-calendar URLs for Google/Outlook/Apple/Yahoo"
patterns-established:
  - "fanOutCloseSummaryEmails() reused by admin-close + admin-resend-summary"
duration: "2 days"
completed: 2026-05-28
---

# Phase 8: Email + iCal Close-Summary Summary

**Per-participant close-summary email via Resend with .ics attachment (RFC 5545, VALARMs). Add-to-calendar buttons for Google/Outlook/Apple/Yahoo. Fire-and-forget via ctx.waitUntil.**

## Accomplishments

- GET /api/ical — personalised .ics download (token-gated)
- GET /ical/<slug>.ics — public minimal .ics
- POST /api/admin/resend-close-summary — manual re-fire
- renderCloseSummaryEmail() — table-based HTML + text fallback
- buildICalForPoll() — RFC 5545 VCALENDAR with VALARMs
- EmailButtons.astro — add-to-calendar UI
- fanOutCloseSummaryEmails() — used by cron + admin-close + resend endpoint

## Next Phase Readiness

Email infrastructure (resend.ts, email-templates.ts) reused by Phase 9 reminders.
