# Phase 6 Plan — Hotel Search (PROVIDER-ABSTRACTED)

> Same pivot as Phase 5: Amadeus dead → build provider abstraction + mock impl. Real provider (Booking.com Affiliate / Hotellook via Travelpayouts / Hostelworld) lands later.
> All paths relative to `D:/dev/when-we-go/`.

## Tasks

### T-01 — HotelProvider interface
**Files:** `worker/lib/hotel-provider.ts` (new)

```ts
export interface HotelSearchInput {
  destinationIata: string;       // resolved from poll.destination
  destinationCity: string;       // for display
  checkInDate: string;           // YYYY-MM-DD
  checkOutDate: string;          // YYYY-MM-DD (exclusive)
  guests: number;
  currency?: string;             // default EUR
}

export interface HotelOption {
  hotelId: string;
  name: string;
  stars: number;                 // 1-5
  distanceToCenterKm: number;
  imageUrl?: string;
  totalPriceEur: number;
  nightlyPriceEur: number;
  perPersonEur: number;
  amenities: string[];
  bookingHint: string;
  source: 'mock' | 'amadeus' | 'booking' | 'hotellook' | 'hostelworld';
}

export interface HotelProvider {
  readonly name: string;
  readonly isReal: boolean;
  searchHotels(input: HotelSearchInput): Promise<HotelOption[]>;
}
```

### T-02 — MockHotelProvider
**Files:** `worker/lib/hotel-provider-mock.ts` (new)

Deterministic mock keyed on `hash(destinationIata + checkInDate + checkOutDate + guests)`:
- 5-8 hotels per query
- Realistic name templates: `Hotel <City>`, `<City> Plaza`, `Generator <City>`, `Hostel <City> Central`, `Boutique <Cityname> <RoofTop|Plaza|Garden>`, etc.
- Stars distribution: mostly 3-4, occasional 2 + 5
- distanceToCenterKm: 0.3-4.5
- Nightly prices: by city tier (top destinations like Copenhagen/Paris higher, secondary cheaper)
- Total = nightly × nights
- perPerson = ceil(total / guests)
- Amenities mix: wifi, breakfast, pool, gym, bar
- All marked source:'mock'
- bookingHint: `"DEMO DATA — search 'Hotel Skt Petri Copenhagen' on Booking.com for real options."`

### T-03 — Provider factory
**Files:** `worker/lib/hotel-provider.ts`

```ts
export function getHotelProvider(env: Env): HotelProvider {
  // Future: if (env.WHENWEGO_BOOKING_AFFILIATE_TOKEN) return new BookingHotelProvider(env);
  return new MockHotelProvider();
}
```

### T-04 — Hotel endpoints
**Files:**
- `worker/handlers/hotels.ts` — `GET /api/hotels?slug=X&token=Y` (any valid token — shared list)
- `worker/handlers/hotels-refresh.ts` — `POST /api/hotels/refresh?slug=X` (organiser-only, rate-limit 1/4h)
- `worker/handlers/admin-hotel-choose.ts` — `POST /api/admin/hotel-choose { slug, hotelId }` (sets `poll_meta.chosen_hotel`)
- `worker/handlers/hotel-vote.ts` — `POST /api/hotel-vote { slug, token, hotelId }` (participant preference vote, increments `poll_meta.hotel_votes:<hotelId>`)

Response shape:
```ts
{
  fetchedAt: number;
  hotels: HotelOption[];
  reason: 'ok' | 'destination_unmapped' | 'no_inventory' | 'provider_error';
  provider: { name: string; isReal: boolean };
  destination?: { iata: string; city: string };
  dateRange?: { checkIn: string; checkOut: string };
  guests: number;
  chosenHotelId?: string;       // poll_meta.chosen_hotel if organiser locked one
  voteTallies?: Record<string, number>;  // hotelId → preference vote count
}
```

### T-05 — Cache integration
Cache key `hotels:<slug>:<checkIn>:<checkOut>:<guests>:<providerName>`. TTL 24h via existing `proposal_cache`.

### T-06 — Cron extension
**Files:** `worker/scheduled.ts`, `worker/lib/close-email-fanout.ts`

On close: fetch hotels via provider, cache, pass into close-summary email.

### T-07 — Email template integration
**Files:** `worker/lib/email-templates.ts`

`renderCloseSummaryEmail` already accepts `hotels?` — verify HOTELS section renders. If `provider.isReal === false`, add DEMO note same shape as flights.

### T-08 — Participant page integration
**Files:** `src/pages/[slug]/[token].astro`, `src/components/HotelShortlist.astro` (new)

Post-close, fetch `/api/hotels?slug=X&token=Y` → render shared shortlist:
- Top 5 by per-person price
- Per-card: name, stars, distance, nightly + total + per-person split
- "Vote for this one" button per card (calls /api/hotel-vote)
- "✓ Chosen by organiser" badge if `chosenHotelId === hotel.hotelId`
- "DEMO data" yellow banner if provider.isReal === false

### T-09 — Admin dashboard integration
**Files:** `src/pages/[slug]/admin/[token].astro`

Show:
- Hotel shortlist with per-card "Mark as chosen" button → /api/admin/hotel-choose
- Vote tallies per hotel
- "Refresh hotels" button

### T-10 — Smoke test extension
Add ~5 checks:
- `GET /api/hotels?slug=X&token=Y` (participant) → 200, hotels.length > 0, provider.isReal === false, all source:'mock'
- `POST /api/hotel-vote` → 200, tally increments
- `POST /api/admin/hotel-choose` org → 200, chosenHotelId set
- Wrong org → 404
- After hotel-choose: response `chosenHotelId` reflects it

### T-11 — Build + verify
1. `npm run build` → 7+ pages
2. `verify-isolation` → exit 0
3. Existing unit tests pass
4. NEW: `node --test worker/lib/hotel-provider-mock.test.ts` → ≥4 tests
5. `wrangler deploy --dry-run` → clean
6. `wrangler dev` + smoke → 44 existing + ~5 new = 49+ pass

## Acceptance

- Hotel shortlist appears post-close
- Per-person price math visible
- DEMO banner when mock active
- Organiser can mark chosen → propagates everywhere
- Vote tallies persist
- Cost-split panel (Phase 10) starts auto-defaulting hotel share from chosen_hotel
