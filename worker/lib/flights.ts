// worker/lib/flights.ts
// Phase 5 (PROVIDER-ABSTRACTED) — thin orchestration layer above the
// FlightProvider interface (see flight-provider.ts). Keeps the previous
// public shape so handlers / cron / email don't need to know about the
// provider swap.
//
// Public API:
//   - searchFlights({env, originIata, destinationIata, departDate, returnDate})
//       resolves to {flights, reason, providerName, providerIsReal} — NEVER
//       throws. Caller stores the result directly in proposal_cache.
//   - FlightCachePayload — what we serialize into proposal_cache (kept
//     backwards-compatible with cost-defaults.ts's `proposals[].priceEur`).
//   - buildFlightCachePayload(...) — helper to construct the cache value.
//
// Reason enum mirrors flight-provider.ts so handlers + UI keep a single set
// of strings to switch on.

import type { Env } from '../durable-object';
import { getFlightProvider } from './flight-provider.ts';
import type { FlightOption, FlightReason } from './flight-provider.ts';

export type { FlightOption, FlightReason } from './flight-provider.ts';

export interface SearchFlightsArgs {
  env: Env;
  originIata: string;
  destinationIata: string;
  /** ISO YYYY-MM-DD */
  departDate: string;
  /** ISO YYYY-MM-DD */
  returnDate: string;
  /** Defaults to 'EUR'. */
  currency?: string;
}

export interface SearchFlightsResult {
  flights: FlightOption[];
  reason: FlightReason;
  providerName: string;
  providerIsReal: boolean;
}

/**
 * Main entrypoint. Resolves to {flights, reason, providerName, providerIsReal}
 * — NEVER throws. Wraps provider.searchFlights in a try/catch so a provider
 * blow-up downgrades to `reason: 'provider_error'` instead of a 500.
 */
export async function searchFlights(
  args: SearchFlightsArgs
): Promise<SearchFlightsResult> {
  const { env, originIata, destinationIata, departDate, returnDate, currency } = args;
  const provider = getFlightProvider(env);

  if (!originIata) {
    return {
      flights: [],
      reason: 'profile_incomplete',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }
  if (!destinationIata) {
    return {
      flights: [],
      reason: 'destination_unmapped',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }

  try {
    const result = await provider.searchFlights({
      originIata,
      destinationIata,
      departDate,
      returnDate,
      currency,
    });
    return {
      flights: result.flights,
      reason: result.reason,
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  } catch (err) {
    console.error(
      `[flights] provider ${provider.name} threw: ${err instanceof Error ? err.message : err}`
    );
    return {
      flights: [],
      reason: 'provider_error',
      providerName: provider.name,
      providerIsReal: provider.isReal,
    };
  }
}

/**
 * Cache shape stored in DO proposal_cache. The `proposals` mirror is kept
 * because cost-defaults.ts (Phase 10) reads `parsed.proposals[0].priceEur`
 * — preserving that contract avoids touching the cost-split pipeline.
 */
export interface FlightCachePayload {
  fetchedAt: number;
  reason: FlightReason;
  flights: FlightOption[];
  /** Mirror of `flights` under the name cost-defaults.ts expects. */
  proposals: Array<{ priceEur: number; airline: string; carrierCode: string }>;
  origin: { iata: string };
  destination: { iata: string };
  dateRange: { start: string; end: string };
  /** Provider attribution for the UI (DEMO banner) + cache-key stability. */
  provider: { name: string; isReal: boolean };
}

export function buildFlightCachePayload(args: {
  reason: FlightReason;
  flights: FlightOption[];
  origin: { iata: string };
  destination: { iata: string };
  dateRange: { start: string; end: string };
  provider: { name: string; isReal: boolean };
}): FlightCachePayload {
  return {
    fetchedAt: Date.now(),
    reason: args.reason,
    flights: args.flights,
    proposals: args.flights.map((f) => ({
      priceEur: f.priceEur,
      airline: f.airline,
      carrierCode: f.carrierCode,
    })),
    origin: args.origin,
    destination: args.destination,
    dateRange: args.dateRange,
    provider: args.provider,
  };
}
