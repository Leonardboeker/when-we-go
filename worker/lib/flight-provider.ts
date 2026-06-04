// worker/lib/flight-provider.ts
// Phase 5 (PROVIDER-ABSTRACTED) — pluggable flight-search interface +
// `getFlightProvider(env)` factory.
//
// Why: Amadeus Self-Service (the original Phase-5 backend) is being
// decommissioned 2026-07-17. We don't want the cron/email/admin pipeline
// blocked on picking a replacement (Kiwi.com Tequila / Skyscanner Rapid /
// Duffel), so this layer abstracts "where do flights come from".
//
// `MockFlightProvider` is the only impl wired today; it returns deterministic
// fake results so the full downstream pipeline can be tested end-to-end.
// A future real provider just adds one branch to `getFlightProvider`.
//
// Reason enum mirrors what callers (handlers, cron, email) already expected
// from the old searchFlights() — kept stable so swapping the provider doesn't
// ripple changes through the rest of the codebase.
//
// `source` on every FlightOption is the provider attribution string — the UI
// uses it to render a "DEMO data" banner when source === 'mock'.

import type { Env } from '../durable-object';

export type FlightReason =
  | 'ok'
  | 'no_routes'
  | 'profile_incomplete'
  | 'destination_unmapped'
  | 'provider_error'
  // Legacy aliases kept so cached payloads from the prior Amadeus impl still
  // deserialise without surprises. New code should not produce these.
  | 'not_configured'
  | 'api_down';

export type FlightSource = 'mock' | 'amadeus' | 'kiwi' | 'skyscanner' | 'duffel';

export interface FlightSearchInput {
  originIata: string;
  destinationIata: string;
  /** ISO YYYY-MM-DD */
  departDate: string;
  /** ISO YYYY-MM-DD — optional one-way (mock always assumes round-trip). */
  returnDate?: string;
  /** Defaults to 'EUR' per CONTEXT D-01. */
  currency?: string;
}

export interface FlightOption {
  airline: string;
  carrierCode: string;
  durationMinTotal: number;
  stops: number;
  priceEur: number;
  priceCurrency: string;
  /** Local ISO at origin, e.g. '2026-07-12T07:30:00'. */
  departureTimeLocal: string;
  /** Local ISO at destination. */
  arrivalTimeLocal: string;
  /** Human-readable hint shown in UI + emails. */
  bookingHint: string;
  /** Provider attribution — UI gates DEMO banner on `source === 'mock'`. */
  source: FlightSource;
}

export interface FlightSearchResult {
  flights: FlightOption[];
  reason: FlightReason;
}

export interface FlightProvider {
  /** Human/log identifier — appears in cache keys + logs. */
  readonly name: string;
  /** Mock impls return false so callers can render a clear DEMO banner. */
  readonly isReal: boolean;
  searchFlights(input: FlightSearchInput): Promise<FlightSearchResult>;
}

/**
 * Single source of truth for "which provider is wired". Currently only
 * MockFlightProvider — future branches add real providers (gated on
 * matching env secret being present). Import via dynamic require to keep
 * the file dependency-graph forward-compatible.
 */
import { MockFlightProvider } from './flight-provider-mock.ts';
import { KiwiFlightProvider } from './flight-provider-kiwi.ts';

export function getFlightProvider(env: Env): FlightProvider {
  if (env.WHENWEGO_KIWI_API_KEY) return new KiwiFlightProvider(env.WHENWEGO_KIWI_API_KEY);
  // Future:
  //   if (env.WHENWEGO_SKYSCANNER_API_KEY) return new SkyscannerFlightProvider(env);
  //   if (env.WHENWEGO_DUFFEL_API_KEY) return new DuffelFlightProvider(env);
  return new MockFlightProvider();
}
