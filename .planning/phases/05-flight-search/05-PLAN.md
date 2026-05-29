# Phase 5 Plan — Flight Search (PROVIDER-ABSTRACTED)

> **PIVOT (2026-05-29):** Amadeus Self-Service portal is being decommissioned 2026-07-17. The whole Phase-5 CONTEXT was built around it. New approach: build a `FlightProvider` interface + a `MockFlightProvider` that returns realistic test data. A real provider (Kiwi.com Tequila, Skyscanner Rapid API, Duffel) gets implemented in a later mini-phase when Leo picks one.
>
> Net result: same endpoints, same email integration, same caching, same graceful-degradation. Just no real flight prices yet — UI shows a clearly-marked "demo data" banner when mock is active.

## Tasks

### T-01 — FlightProvider interface
**Files:** `worker/lib/flight-provider.ts` (new)

```ts
export interface FlightSearchInput {
  originIata: string;
  destinationIata: string;
  departDate: string;        // YYYY-MM-DD
  returnDate?: string;       // YYYY-MM-DD, optional one-way
  currency?: string;         // default EUR
}

export interface FlightOption {
  airline: string;
  carrierCode: string;
  durationMinTotal: number;
  stops: number;
  priceEur: number;
  priceCurrency: string;
  departureTimeLocal: string;
  arrivalTimeLocal: string;
  bookingHint: string;       // e.g. "Search 'LH 2270' on Google Flights"
  source: 'mock' | 'amadeus' | 'kiwi' | 'skyscanner' | 'duffel'; // provider attribution
}

export interface FlightProvider {
  readonly name: string;
  readonly isReal: boolean;  // mock providers return false; real ones true
  searchFlights(input: FlightSearchInput): Promise<FlightOption[]>;
}
```

### T-02 — MockFlightProvider
**Files:** `worker/lib/flight-provider-mock.ts` (new)

Deterministic mock that returns 4-8 plausible flight options based on origin + destination + date:
- Seeds RNG from `hash(originIata + destinationIata + departDate)` so same query → same results (cache-friendly)
- Realistic airline mix per region (Europe: LH, SAS, KLM, AF, BA, U2, FR; North America: DL, UA, AA, AC; etc.)
- Realistic price ranges by route distance (short-haul €60-€250, medium €150-€500, long-haul €450-€1500)
- 1-3 direct + 2-5 with 1 stop
- Times spread across the day (morning, mid-day, evening)
- ALL marked `source: 'mock'`
- Adds a clear `bookingHint` like `"DEMO DATA — search 'LH FRA-CPH' on Google Flights for real options"`

This isn't trying to be a real search engine — it's enough to test the entire downstream pipeline (cache, email render, T-30 refresh, admin view) end-to-end with realistic-shape data.

### T-03 — Provider factory
**Files:** `worker/lib/flight-provider.ts`

```ts
export function getFlightProvider(env: Env): FlightProvider {
  // Future: if (env.WHENWEGO_KIWI_API_KEY) return new KiwiFlightProvider(env);
  //         if (env.WHENWEGO_SKYSCANNER_API_KEY) return new SkyscannerFlightProvider(env);
  return new MockFlightProvider();
}
```

Single source of truth for "which provider is wired in". Future real providers just add a branch.

### T-04 — Destination → IATA mapping
**Files:** `src/data/cities-to-airports.json` (new)

~100 cities, lowercase keys → IATA codes (e.g. `"copenhagen": "CPH"`). Hand-curated top destinations. Used by both flights + hotels (Phase 6).

Helper `worker/lib/destinations.ts`:
- `resolveDestinationIata(destinationStr): string | null` — splits on `,`, lowercases first segment, looks up

### T-05 — DO cache integration
**Files:** uses existing `proposal_cache` table from Phase 9.

No new table. Cache key format: `flights:<token>:<departDate>:<returnDate>:<provider>`. TTL 24h via existing `getCached`/`setCached`.

### T-06 — Flight endpoints
**Files:**
- `worker/handlers/flights.ts` (new) — `GET /api/flights?slug=X&token=Y`
- `worker/handlers/flights-refresh.ts` (new) — `POST /api/flights/refresh?slug=X&token=Y` (rate-limit 1/h per token via DO meta `flights_refresh_at:<token>`)
- `worker/handlers/admin-flights.ts` (new) — `GET /api/admin/flights?slug=X` (organiser-token, returns all participants' flights)

Auth + 404-on-wrong-token same convention.

Response shape:
```ts
{
  fetchedAt: number;
  flights: FlightOption[];
  reason: 'ok' | 'profile_incomplete' | 'no_routes' | 'destination_unmapped' | 'provider_error';
  provider: { name: string; isReal: boolean };  // so UI can show "demo data" banner
  origin?: { iata: string; city: string };
  destination?: { iata: string; city: string };
  dateRange?: { start: string; end: string };
}
```

### T-07 — Cron extension
**Files:** `worker/scheduled.ts`, `worker/lib/close-email-fanout.ts`

On poll close (after closeNow + setTrip_start, before close-summary email fan-out):
- For each participant with `profile.homeAirport`: fire `provider.searchFlights` in parallel via `Promise.allSettled`
- Cache results
- Pass into close-summary email render so the FLIGHTS section populates

Wrap in try/catch — flight fetch failure doesn't block email sends.

### T-08 — Email template integration
**Files:** `worker/lib/email-templates.ts` (extend)

`renderCloseSummaryEmail` already accepts `flights?` per Phase 8 — verify the FLIGHTS section now renders with mock data populated. If `provider.isReal === false`, add a small "Demo flight data — see [README link] for real provider setup" note.

Also extend `renderT30Email` so T-30 reminder shows refreshed flight prices (Phase 9 wires this — for mock provider, "refreshed" returns same deterministic data).

### T-09 — T-30 reminder integration
**Files:** `worker/lib/reminder-fanout.ts`

For T-30: before sending each participant's email, force-refresh their flights (bypass cache via direct `searchFlights` call). Pass into `renderT30Email`.

### T-10 — Participant page integration
**Files:** `src/pages/[slug]/[token].astro`, `src/components/FlightOptions.astro` (new)

Post-close, fetch `/api/flights?slug=X&token=Y` and render FlightOptions component:
- 3 cheapest cards with airline / duration / stops / price / "Book this →" button
- Collapsible "See all options"
- Refresh button (rate-limited, shows "Refreshing…" → success/error)
- **If `provider.isReal === false`:** yellow striped "📍 DEMO flight data — real provider not configured" banner at the top of the FlightOptions section
- If reason !== 'ok': render appropriate message ("Complete your profile to see flights" / "No routes found — try [Google Flights link]")

### T-11 — Smoke test extension
**Files:** `scripts/smoke-test.mjs`

Add:
- `GET /api/flights?slug=X&token=Y` (no profile) → 200, reason 'profile_incomplete'
- After setting profile via POST /api/profile with homeAirport=MUC → `GET /api/flights` returns 200, reason 'ok', `flights.length > 0`, `provider.isReal === false`, `flights[0].source === 'mock'`
- `POST /api/flights/refresh` → 200 + flights returned
- `GET /api/admin/flights?slug=X` with org → 200, returns per-participant results
- Wrong org token → 404
- Verify all returned flights have `source: 'mock'` for now

### T-12 — Build + verify
1. `npm run build` → 7+ pages
2. `verify-isolation` → exit 0
3. Existing unit tests still pass
4. `wrangler deploy --dry-run` → clean
5. `wrangler dev` + smoke → 37 existing + ~6 new = 43+ pass

## Acceptance

- All 3 flight endpoints return 200 with mock data when profile complete
- Participant page shows mock flight options with clear "DEMO" banner
- Cron close fires flight search for each participant with profile
- Email template includes flight section when populated
- Provider abstraction is clean — adding `KiwiFlightProvider` later = 1 file + 1 line in `getFlightProvider`
- Phase 9 + earlier smoke tests still green

## What's deferred (real provider integration — future mini-phase 5b)

- Sign up for Kiwi.com Tequila OR Skyscanner Rapid OR Duffel
- Implement provider class
- Add branch to `getFlightProvider` factory
- Real prices flow through unchanged downstream
