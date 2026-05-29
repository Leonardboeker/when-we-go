// worker/lib/hotels.ts
// Phase 6 (PROVIDER-ABSTRACTED) — thin orchestration layer above the
// HotelProvider interface (see hotel-provider.ts). Mirrors flights.ts.
//
// Public API:
//   - searchHotels({env, destinationIata, destinationCity, checkInDate, checkOutDate, guests, currency})
//       → {hotels, reason, providerName, providerIsReal} — NEVER throws.
//   - HotelCachePayload — what we serialise into proposal_cache (kept
//     compact + JSON-friendly so cost-defaults' helper can reuse it).
//   - buildHotelCachePayload(...) — helper for callers (handlers + cron).
//
// Reason enum mirrors hotel-provider.ts so handlers + UI keep a single set
// of strings to switch on.

import type { Env } from '../durable-object';
import { getHotelProvider } from './hotel-provider.ts';
import type { HotelOption, HotelReason } from './hotel-provider.ts';

export type { HotelOption, HotelReason } from './hotel-provider.ts';

export interface SearchHotelsArgs {
  env: Env;
  destinationIata: string;
  destinationCity: string;
  checkInDate: string;
  checkOutDate: string;
  guests: number;
  currency?: string;
}

export interface SearchHotelsResult {
  hotels: HotelOption[];
  reason: HotelReason;
  providerName: string;
  providerIsReal: boolean;
}

/**
 * Main entrypoint. Resolves to {hotels, reason, providerName, providerIsReal}
 * — NEVER throws. Wraps provider.searchHotels in a try/catch so a provider
 * blow-up downgrades to `reason: 'provider_error'` instead of a 500.
 */
export async function searchHotels(
  args: SearchHotelsArgs
): Promise<SearchHotelsResult> {
  const provider = getHotelProvider(args.env);

  if (!args.destinationIata) {
    return {
      hotels: [],
      reason: 'destination_unmapped',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }

  try {
    const result = await provider.searchHotels({
      destinationIata: args.destinationIata,
      destinationCity: args.destinationCity,
      checkInDate: args.checkInDate,
      checkOutDate: args.checkOutDate,
      guests: args.guests,
      currency: args.currency,
    });
    return {
      hotels: result.hotels,
      reason: result.reason,
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  } catch (err) {
    console.error(
      `[hotels] provider ${provider.name} threw: ${err instanceof Error ? err.message : err}`
    );
    return {
      hotels: [],
      reason: 'provider_error',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }
}

/**
 * Cache shape stored in DO proposal_cache. Single key per (slug, dateRange,
 * guests, providerName) — everyone in the same poll sees the same list.
 */
export interface HotelCachePayload {
  fetchedAt: number;
  reason: HotelReason;
  hotels: HotelOption[];
  destination: { iata: string; city: string };
  dateRange: { checkIn: string; checkOut: string };
  guests: number;
  /** Provider attribution for the UI (DEMO banner) + cache-key stability. */
  provider: { name: string; isReal: boolean };
}

export function buildHotelCachePayload(args: {
  reason: HotelReason;
  hotels: HotelOption[];
  destination: { iata: string; city: string };
  dateRange: { checkIn: string; checkOut: string };
  guests: number;
  provider: { name: string; isReal: boolean };
}): HotelCachePayload {
  return {
    fetchedAt: Date.now(),
    reason: args.reason,
    hotels: args.hotels,
    destination: args.destination,
    dateRange: args.dateRange,
    guests: args.guests,
    provider: args.provider,
  };
}

/**
 * Build the cache key for the shared hotel list. Provider name is included
 * so swapping providers later invalidates cleanly.
 */
export function hotelCacheKey(
  slug: string,
  dateRange: { checkIn: string; checkOut: string } | null,
  guests: number,
  providerName: string
): string {
  if (!dateRange) return `hotels:${slug}:nodate:${guests}:${providerName}`;
  return `hotels:${slug}:${dateRange.checkIn}:${dateRange.checkOut}:${guests}:${providerName}`;
}
