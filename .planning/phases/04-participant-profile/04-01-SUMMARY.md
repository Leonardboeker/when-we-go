---
phase: 04-participant-profile
plan: 01
subsystem: "profile"
tags: ["astro", "worker", "durable-object"]
provides: ["participant-profile"]
affects: ["participant-page", "admin-page", "worker-poll-handler"]
tech-stack:
  added: ["airports.json (top-200 IATA list)"]
  patterns: ["DO profile table", "onboarding gate before calendar"]
key-files:
  created:
    - worker/handlers/profile.ts
    - src/components/ProfileForm.astro
    - src/lib/profile.ts
    - src/data/airports.json
  modified:
    - worker/durable-object.ts
    - worker/handlers/poll.ts
    - worker/handlers/admin-poll.ts
    - worker/index.ts
    - worker/lib/schemas.ts
    - src/pages/[slug]/[token].astro
    - src/pages/[slug]/admin/[token].astro
key-decisions:
  - "Profile stored in DO (not polls.json) — avoids committing emails to git"
  - "Onboarding gate: calendar hidden until profile submitted on first visit"
  - "Email omitted → email pipeline skips that participant (Telegram-only mode)"
patterns-established:
  - "participant_profile DO table pattern reused by Phase 8 for email delivery"
duration: "1 day"
completed: 2026-05-28
---

# Phase 4: Participant Profile Summary

**Participant onboarding form collects email + home airport (IATA autocomplete) + optional budget/interests; stored in DO per participant, gates calendar on first visit.**

## Performance

- **Duration:** 1 day
- **Tasks:** 1 plan, all tasks complete
- **Files modified:** 13

## Accomplishments

- `POST /api/profile` endpoint stores profile in `participant_profile` DO table
- `ProfileForm.astro` with IATA autocomplete from bundled top-200 airports list
- Onboarding gate: calendar grid hidden until profile submitted
- `GET /api/poll` extended to return viewer's own profile (never others')
- Admin dashboard shows per-participant profile-completeness indicator
- `smoke-test.mjs` extended with profile assertions

## Files Created/Modified

- `worker/handlers/profile.ts` — POST /api/profile, same token auth as /api/vote
- `src/components/ProfileForm.astro` — onboarding form, vanilla JS, IATA autocomplete
- `src/lib/profile.ts` — client-side profile helpers
- `src/data/airports.json` — bundled top-200 IATA airports by traffic
- `worker/durable-object.ts` — participant_profile table, getProfile/setProfile methods

## Decisions & Deviations

Profile data lives in DO, not polls.json — would commit participant emails to git otherwise.

## Next Phase Readiness

Email + homeAirport available for Phase 5 (flights), Phase 8 (emails).
