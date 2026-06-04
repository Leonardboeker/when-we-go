// worker/lib/hotel-provider.ts
// Phase 6 (PROVIDER-ABSTRACTED) — pluggable hotel-search interface +
// `getHotelProvider(env)` factory. Mirrors flight-provider.ts.
//
// Why: Amadeus Self-Service (the originally-planned Phase-6 backend) is being
// decommissioned 2026-07-17. Rather than block the close-summary / admin /
// cost-split pipeline on picking a replacement (Booking.com Affiliate /
// Hotellook via Travelpayouts / Hostelworld), this layer abstracts
// "where do hotels come from".
//
// `MockHotelProvider` is the only impl wired today; it returns deterministic
// fake hotel options so the end-to-end pipeline (shortlist + organiser choose
// + participant vote + cost-split auto-default) can be exercised without
// burning API quota.
//
// Reason enum mirrors what callers (handler / cron / email) expected from the
// old searchHotels() — kept stable so swapping the provider doesn't ripple
// through the rest of the codebase.
//
// `source` on every HotelOption is the provider attribution string — the UI
// renders a "DEMO data" banner when source === 'mock'.
import type { Env } from '../durable-object';

export type HotelReason =
  | 'ok'
  | 'destination_unmapped'
  | 'no_inventory'
  | 'provider_error';

export type HotelSource =
  | 'mock'
  | 'amadeus'
  | 'booking'
  | 'hotellook'
  | 'hostelworld';

export interface HotelSearchInput {
  /** Resolved IATA code for the destination (drives the seed for mock). */
  destinationIata: string;
  /** Display city name (used for hotel name templates + bookingHint). */
  destinationCity: string;
  /** ISO YYYY-MM-DD — inclusive. */
  checkInDate: string;
  /** ISO YYYY-MM-DD — exclusive (standard hotel convention). */
  checkOutDate: string;
  /** Headcount used for perPerson math. */
  guests: number;
  /** Defaults to 'EUR' per CONTEXT D-01. */
  currency?: string;
}

export interface HotelOption {
  hotelId: string;
  name: string;
  /** 1-5 inclusive. */
  stars: number;
  distanceToCenterKm: number;
  imageUrl?: string;
  /** Booking.com / direct link pre-filled with dates + guests. */
  bookingUrl?: string;
  totalPriceEur: number;
  nightlyPriceEur: number;
  perPersonEur: number;
  amenities: string[];
  /** Human-readable hint shown in UI + emails. */
  bookingHint: string;
  /** Provider attribution — UI gates DEMO banner on `source === 'mock'`. */
  source: HotelSource;
}

export interface HotelSearchResult {
  hotels: HotelOption[];
  reason: HotelReason;
}

export interface HotelProvider {
  /** Human/log identifier — appears in cache keys + logs. */
  readonly name: string;
  /** Mock impls return false so callers can render a clear DEMO banner. */
  readonly isReal: boolean;
  searchHotels(input: HotelSearchInput): Promise<HotelSearchResult>;
}

/**
 * Single source of truth for "which hotel provider is wired". Currently only
 * MockHotelProvider — future branches add real providers gated on the
 * matching env secret being present. Mirrors getFlightProvider exactly.
 */
import { MockHotelProvider } from './hotel-provider-mock.ts';

export function getHotelProvider(_env: Env): HotelProvider {
  // Future:
  //   if (_env.WHENWEGO_BOOKING_AFFILIATE_TOKEN) return new BookingHotelProvider(_env);
  //   if (_env.WHENWEGO_HOTELLOOK_API_KEY) return new HotellookHotelProvider(_env);
  //   if (_env.WHENWEGO_HOSTELWORLD_API_KEY) return new HostelworldHotelProvider(_env);
  return new MockHotelProvider();
}
