# Phase 5 Context — Flight Search (Amadeus)

> Per-participant flight options surfaced post-close, sourced from Amadeus Self-Service API free tier.

## Goal

After a poll closes, each participant sees flight options FROM their home airport TO the destination FOR the locked dates, sorted by price (cheapest highlighted) + duration (fastest secondary).

## Decisions

### D-01 — API: Amadeus Self-Service

Why: free tier 2000 req/month, OAuth2 simple, single key covers flights + hotels (Phase 6 reuses), real airline NDC content.

**Endpoints used:**
- `POST /v1/security/oauth2/token` — client-credentials → bearer (cache 25 min, expires at 30 min)
- `GET /v2/shopping/flight-offers?originLocationCode=MUC&destinationLocationCode=CPH&departureDate=2026-07-12&returnDate=2026-07-15&adults=1&currencyCode=EUR&max=10`

Response is verbose (one offer can be 5KB JSON). We normalise to:

```ts
interface FlightOption {
  airline: string;          // e.g. "Lufthansa" — resolved from carrier code
  carrierCode: string;      // "LH"
  durationMinTotal: number; // total trip duration outbound
  stops: number;
  priceEur: number;
  priceCurrency: string;    // "EUR"
  departureTimeLocal: string; // ISO local at origin
  arrivalTimeLocal: string;   // ISO local at destination
  bookingHint: string;      // "Search 'LH 2270' on Lufthansa.com"
}
```

### D-02 — Caching strategy

Cache per (slug, token, search-date-pair). Two reasons:
1. Amadeus rate-limit on free tier: 10 req/sec, daily caps. Caching avoids burning quota on every page reload.
2. Flight prices DO change but not minute-to-minute — once a day is fine for our use case.

Cache TTL: 24 hours. Cache stored in DO `proposal_cache` table:

```sql
CREATE TABLE IF NOT EXISTS proposal_cache (
  cache_key   TEXT PRIMARY KEY,   -- e.g. "flights:LeoToken:2026-07-12:2026-07-15"
  value_json  TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL    -- unix ms
);
```

DO methods:
- `getCached(cacheKey)`: returns `{ value, fetchedAt }` if exists, else null
- `setCached(cacheKey, value)`: upsert
- `clearCachedByPrefix(prefix)`: e.g. `flights:` to force-refresh all flights

### D-03 — Trigger points

Flights fetched:
1. **On poll close** (Phase 2 cron): `scheduled.ts` extended to call `getFlights(slug, token)` for each participant in parallel via `Promise.allSettled` (failures don't block others). `ctx.waitUntil(...)` so cron doesn't block on slow API calls.
2. **On participant page load** (post-close): `GET /api/flights?slug=X&token=Y` — returns cached if fresh, else fetches synchronously. Loading state during fetch (spinner in flight section).
3. **Manual refresh** (button on participant page): `POST /api/flights/refresh?slug=X&token=Y` — bypasses cache, rate-limited to 1/hour per (slug, token).
4. **On reminder cron** (Phase 9): T-30 reminder triggers a re-fetch (prices likely changed in 30 days).

### D-04 — Auth handling

Token caching at module level (Worker isolate scope):

```ts
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAmadeusToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  // POST to /v1/security/oauth2/token with grant_type=client_credentials
  // Response: { access_token, expires_in: 1800 }
  // Cache with 60s buffer before stated expiry
  ...
}
```

### D-05 — Error handling

| Scenario | Response |
|---|---|
| Missing `WHENWEGO_AMADEUS_CLIENT_ID` env var | Log warning, return `{ flights: [], reason: 'not_configured' }`. Frontend shows "Flight suggestions not configured — ask your organiser". |
| Amadeus API 5xx | Retry once after 2s, then return cached if any (even if stale), else empty + reason `'api_down'` |
| No flights found (e.g. obscure airport pair) | Return empty + reason `'no_routes'`. Frontend shows "No direct flights found — try [Google Flights link]". |
| Participant has no `homeAirport` in profile | Return empty + reason `'profile_incomplete'`. Frontend prompts profile completion. |
| Destination not a recognised airport | Fallback: map destination string → IATA via simple table (`src/data/cities-to-airports.json`, top 100 cities). If still no match, error reason `'destination_unmapped'`. |

### D-06 — Destination → airport mapping

Polls have free-text `destination` like "Copenhagen, Denmark". Amadeus needs IATA. Mapping table `src/data/cities-to-airports.json`:

```json
{
  "copenhagen": "CPH",
  "munich": "MUC",
  "berlin": "BER",
  ...
}
```

100 entries, lowercase fuzzy match on the leading city name (before any comma). If unmapped: organiser can override via optional `destinationIata` field in poll config.

### D-07 — API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/flights?slug=X&token=Y` | participant token (query) | Returns cached or fresh flights for this participant |
| POST | `/api/flights/refresh?slug=X&token=Y` | participant token (body) | Force-refresh (rate-limit 1/h per token) |
| GET | `/api/admin/flights?slug=X` | organiser token (header) | All participants' flights (for admin dashboard summary) |

Response shape:

```ts
{
  fetchedAt: number,
  flights: FlightOption[],     // empty if reason !== 'ok'
  reason: 'ok' | 'no_routes' | 'profile_incomplete' | 'not_configured' | 'api_down' | 'destination_unmapped',
  // For UI hints
  origin?: { iata: string, city: string },
  destination?: { iata: string, city: string },
  dateRange?: { start: string, end: string }
}
```

### D-08 — Frontend integration

Post-close participant page gets a new `<FlightOptions />` component below the calendar grid:

- Loading state while fetching
- 3 cheap-first cards + collapsible "see all" for the rest
- Per-card: airline logo (from a small CDN like https://images.kiwi.com/airlines/...), price, duration, stops, departure/arrival times
- "Refresh prices" button (rate-limited)
- "Book this" → opens new tab with `bookingHint` text + a Google Flights search prefilled with the date pair

Admin dashboard adds an "All flights" table — one row per participant + their cheapest option, to give the organiser a sense of total trip cost.

### D-09 — Cost math

| Trigger | Calls |
|---|---|
| Poll close (4 participants) | 4 |
| Participant page loads (4 ppl × 5 visits over trip) | 0 if cached |
| Manual refreshes | 4 (1/h cap) |
| T-30 reminder re-fetch | 4 |
| T-7 reminder re-fetch | 4 |
| **Per-poll total** | **~16 calls** |

Free tier: 2000/month → 125 polls/month before paying. Paid tier: $0.005/call after = pennies.

## What's intentionally NOT in this phase

- Booking deep-links beyond Google Flights search (Phase 11 future)
- Multi-city / open-jaw routing (some participants from one city, others from another — Amadeus supports, our UI doesn't, defer)
- Hotel + flight bundled fares (Amadeus has a bundles endpoint, defer)
- Frequent flyer / cabin class filters (defer)
- LCC inclusion (Ryanair/EasyJet not in free Amadeus tier — note in UI: "doesn't include low-cost carriers — check Skyscanner separately for those")

## Acceptance criteria

1. After `POST /api/admin/close`, each participant with a complete profile has flights cached in DO within 30s
2. `GET /api/flights` returns cached results <50ms, fresh fetches <3s
3. UI renders 3 cheap cards + expandable list, "refresh" button respects 1/h limit
4. Missing profile → friendly UX prompt, not silent failure
5. Amadeus down → cached results served if any; never a 500 to the user
6. Cron extension: closing a 4-person poll uses 4 Amadeus calls + 0 if all profiles incomplete
7. Smoke test extension: POST close → assert each participant's `/api/flights` returns `reason: 'ok'` (with seeded mock Amadeus responses for CI)
