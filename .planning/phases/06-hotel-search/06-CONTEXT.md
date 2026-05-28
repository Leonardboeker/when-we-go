# Phase 6 Context — Hotel Search (Amadeus)

> Shared hotel shortlist for the destination on the locked dates. One-shot per poll, displayed to all participants.

## Goal

After close, fetch ~5 hotels in the destination city for the date range, sorted by per-night price (with star rating + distance-to-center indicator). Everyone sees the same list (they're rooming together). Organiser can flag "this is the one".

## Decisions

### D-01 — API: same Amadeus key as Phase 5

Reuses `WHENWEGO_AMADEUS_CLIENT_ID` + `WHENWEGO_AMADEUS_CLIENT_SECRET`. No new env vars needed.

Two-endpoint chain (Amadeus pattern):
1. `GET /v1/reference-data/locations/hotels/by-city?cityCode=CPH&radius=5&ratings=3,4,5` — list of ~50 hotel IDs near the city
2. `GET /v3/shopping/hotel-offers?hotelIds=HTLID1,HTLID2,...&checkInDate=2026-07-12&checkOutDate=2026-07-15&adults=4&currency=EUR&bestRateOnly=true` — actual prices

Normalised shape:

```ts
interface HotelOption {
  hotelId: string;          // Amadeus internal
  name: string;
  stars: number;            // 1-5
  distanceToCenterKm: number;
  imageUrl?: string;        // from Amadeus media (often missing)
  totalPriceEur: number;    // for full trip
  nightlyPriceEur: number;
  perPersonEur: number;     // totalPrice / participantCount
  amenities: string[];      // ['wifi', 'breakfast', ...] — top 3 only
  bookingHint: string;      // "Search 'Hotel Skt Petri Copenhagen' on Booking.com"
}
```

### D-02 — Caching

Single cache key per slug (not per participant — same list for everyone):

```
cache_key: "hotels:<slug>"
```

TTL 24h, same DO `proposal_cache` table as Phase 5.

### D-03 — Trigger points

1. **On close** (cron): fetch + cache during `closeNow()` aftermath
2. **Page load** (post-close): served from cache <50ms
3. **Manual refresh**: `POST /api/hotels/refresh?slug=X` (organiser-token gated, rate-limit 1/4h)

### D-04 — UI integration

`<HotelShortlist />` component on both participant page + admin page (same data, different actions):
- Participant view: read-only cards, "Vote for this one" link calls a lightweight `POST /api/hotel-vote { slug, token, hotelId }` (stored in DO `poll_meta` as `hotel_votes:<hotelId>` counter)
- Admin view: same cards + "Mark as chosen" button → writes `poll_meta.chosen_hotel = hotelId`
- Once `chosen_hotel` set, all UIs show that one with a "✓ Chosen" badge

### D-05 — Per-person price math

`perPersonEur = Math.ceil(totalPriceEur / participants.length)`.

Show with explainer: "€420 ÷ 4 = €105/person". Math is upfront so people see it; no "trust me" reservations.

### D-06 — Error handling

| Scenario | Response |
|---|---|
| Destination city not in Amadeus | Fallback to `destinationIata` from Phase 5 mapping; if still no, error |
| No hotels available for dates | Empty list + reason `'sold_out_or_no_inventory'`, suggest tries adjacent dates |
| Hotel images missing | Skip image, show name + stars only |
| Price in non-EUR currency | Convert via Amadeus exchange rate header |

### D-07 — API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/hotels?slug=X&token=Y` | any valid token | Shared hotel list |
| POST | `/api/hotels/refresh?slug=X` | organiser | Force-refresh |
| POST | `/api/hotel-vote { slug, token, hotelId }` | participant | Cast preference vote |
| POST | `/api/admin/hotel-choose { slug, hotelId }` | organiser | Lock the choice |

### D-08 — Cost math

| Trigger | Calls (2-endpoint chain counts as 2) |
|---|---|
| Per close | 2 |
| Per T-30 + T-7 refresh | 4 |
| Manual refreshes | ~2 |
| **Per-poll total** | **~8 calls** |

Combined with Phase 5: ~24 Amadeus calls/poll. Free tier 2000/mo → ~80 polls/month with both phases active. Plenty.

## What's intentionally NOT in this phase

- Airbnb / Vrbo inventory (Amadeus doesn't have it; bypass by manually adding to a "external options" section if asked)
- Booking flow inside our app (always opens external)
- Multi-room logic ("we need 2 rooms because 4 ppl") — annotate where >2 guests per standard room, but don't programmatically split
- Filters (price range, neighborhood) — top-5-by-price is enough for friend trips

## Acceptance criteria

1. Post-close hotels appear in cached form on participant + admin views
2. Per-person price math visible
3. Participants can cast preference votes; admin sees aggregate
4. Admin "Mark as chosen" propagates to all views
5. Amadeus down → cached or graceful empty state
