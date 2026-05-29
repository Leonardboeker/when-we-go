---
phase: 05-flight-search
plan: 01
subsystem: "flights"
tags: ["worker", "provider-abstracted", "mock"]
provides: ["flight-search"]
affects: ["participant-page", "admin-page", "close-email-fanout", "cron"]
tech-stack:
  added: ["flight-provider abstraction", "cities-to-airports mapping"]
  patterns: ["FlightProvider interface + getFlightProvider() factory", "proposal_cache"]
key-files:
  created:
    - worker/lib/flight-provider.ts
    - worker/lib/flight-provider-mock.ts
    - worker/lib/flights.ts
    - worker/lib/destinations.ts
    - worker/handlers/flights.ts
    - worker/handlers/flights-refresh.ts
    - worker/handlers/admin-flights.ts
    - src/components/FlightOptions.astro
    - src/data/cities-to-airports.json
  modified:
    - worker/durable-object.ts
    - worker/index.ts
    - worker/lib/close-email-fanout.ts
    - src/pages/[slug]/[token].astro
key-decisions:
  - "Provider-abstracted — Amadeus decommissioned 2026-07-17, Kiwi.com Tequila wired as real impl"
  - "MockFlightProvider ships as default; DEMO banner shown in UI when source=mock"
  - "24h proposal_cache TTL"
patterns-established:
  - "FlightProvider pattern reused by HotelProvider (Phase 6) and ActivityProvider (Phase 7)"
duration: "2 days"
completed: 2026-05-29
---

# Phase 5: Flight Search Summary

**Provider-abstracted flight search with MockFlightProvider default and Kiwi.com Tequila as real impl. Per-participant cached results via DO proposal_cache.**

## Accomplishments

- GET /api/flights — per-participant, cache-first, graceful reasons
- POST /api/flights/refresh — force-refresh, 1h rate-limit
- GET /api/admin/flights — organiser aggregate view
- MockFlightProvider — deterministic per (origin, dest, date) RNG
- FlightOptions.astro with DEMO banner when source=mock
- Wired into close-summary email fan-out + cron pre-fetch on close

## Decisions & Deviations

Amadeus was the original backend but decommissioned mid-build. Provider layer abstractd; Kiwi.com Tequila added as KiwiFlightProvider in follow-up commit.

## Next Phase Readiness

Provider pattern reused by Phase 6 (hotels). Flight cache available to Phase 8 emails.
