// worker/lib/flight-provider.ts
// Phase 5 (PROVIDER-ABSTRACTED) — pluggable flight-search interface +
// `getFlightProvider(env)` factory.
//
// Why: Amadeus Self-Service (the original Phase-5 backend) is being
// decommissioned 2026-07-17. We don't want the cron/email/admin pipeline
// blocked on picking a replacement (Kiwi.com Tequila / Skyscanner Rapid /
// Duffel), so this layer abstracts "where do flights come from".
//
// `KiwiPublicFlightProvider` (keyless Kiwi.com Skypicker GraphQL) is the
// default REAL impl wired today; `KiwiFlightProvider` (Tequila) takes over when
// WHENWEGO_KIWI_API_KEY is set. `MockFlightProvider` still exists for tests but
// is no longer wired into the factory — real flights are the default now.
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
  /**
   * Absolute deep-link to book this exact itinerary (KiwiPublicFlightProvider
   * populates it; mock/Tequila leave it undefined). UI + emails render a
   * "Buchen" affordance when present, else fall back to a generic search link.
   */
  bookingUrl?: string;
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
 * Single source of truth for "which provider is wired". Default is the keyless
 * KiwiPublicFlightProvider (real flights, no secret); KiwiFlightProvider
 * (Tequila) wins when WHENWEGO_KIWI_API_KEY is set. Future paid providers add
 * their own branches gated on the matching env secret.
 */
import { KiwiFlightProvider } from './flight-provider-kiwi.ts';
import { KiwiPublicFlightProvider } from './flight-provider-kiwi-public.ts';

export function getFlightProvider(env: Env): FlightProvider {
  // 1. If a Tequila API key is configured, prefer it (explicit opt-in).
  if (env.WHENWEGO_KIWI_API_KEY) return new KiwiFlightProvider(env.WHENWEGO_KIWI_API_KEY);
  // 2. Default REAL provider — keyless Kiwi.com public Skypicker GraphQL.
  //    No env/secret needed; returns genuine itineraries + booking deep-links.
  //    On any failure its searchFlights() resolves to reason:'provider_error'
  //    (or throws, which the flights.ts wrapper catches → 'provider_error').
  //   Future:
  //   if (env.WHENWEGO_SKYSCANNER_API_KEY) return new SkyscannerFlightProvider(env);
  //   if (env.WHENWEGO_DUFFEL_API_KEY) return new DuffelFlightProvider(env);
  return new KiwiPublicFlightProvider();
}
