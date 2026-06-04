---
phase: 06-hotel-search
plan: 01
subsystem: "hotels"
tags: ["worker", "provider-abstracted", "mock"]
provides: ["hotel-search"]
affects: ["participant-page", "admin-page", "close-email-fanout", "cron"]
tech-stack:
  added: ["hotel-provider abstraction"]
  patterns: ["HotelProvider interface + getHotelProvider() factory"]
key-files:
  created:
    - worker/lib/hotel-provider.ts
    - worker/lib/hotel-provider-mock.ts
    - worker/lib/hotels.ts
    - worker/handlers/hotels.ts
    - worker/handlers/hotels-refresh.ts
    - worker/handlers/hotel-vote.ts
    - worker/handlers/admin-hotel-choose.ts
    - src/components/HotelShortlist.astro
  modified:
    - worker/index.ts
    - worker/lib/close-email-fanout.ts
    - worker/lib/cost-defaults.ts
    - worker/lib/reminder-fanout.ts
    - worker/scheduled.ts
    - src/pages/[slug]/[token].astro
    - src/pages/[slug]/admin/[token].astro
key-decisions:
  - "Shared list (one cache key per slug) — participants room together"
  - "Per-person price split math done in cost-defaults.ts"
  - "Organiser can mark chosen hotel via POST /api/admin/hotel-choose"
patterns-established:
  - "Same provider-abstracted pattern as Phase 5 flights"
duration: "1 day"
completed: 2026-05-29
---

# Phase 6: Hotel Search Summary

**Provider-abstracted shared hotel shortlist for the destination. MockHotelProvider default. Organiser can lock a choice; per-person price split shown.**

## Accomplishments

- GET /api/hotels — shared list, cache-first, 24h TTL
- POST /api/hotels/refresh — organiser force-refresh
- POST /api/hotel-vote — participant hotel preference (non-binding)
- POST /api/admin/hotel-choose — organiser locks hotel choice
- HotelShortlist.astro with per-person split math
- Wired into close-email fan-out + cron pre-fetch

## Next Phase Readiness

Hotel cost data feeds Phase 10 pay-me-back cost split defaults.
