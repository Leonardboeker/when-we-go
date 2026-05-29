// worker/lib/cost-defaults.ts
// Phase 10 — compute default cost-split rows for each participant before
// the organiser opens the admin "Split costs" panel.
//
// Inputs come from two future-Phase data sources via poll_meta + proposal_cache:
//   - poll_meta.chosen_hotel  → set by Phase 6 (hotel polling). JSON-encoded
//     { name, totalPriceEur, ... }. Until Phase 6 ships → unset → hotelShare 0.
//   - proposal_cache['flights:<token>'] → set by Phase 5 (Amadeus). JSON blob
//     with `proposals: [{ priceEur, ... }, ...]` sorted cheapest-first.
//     Until Phase 5 ships → unset → flightCost 0.
//
// "Other" is always 0 by default (organiser-fillable catch-all).
//
// All amounts are stored as integer EUR (rounded up via Math.ceil) for clean
// display and clean export.

import type { Poll } from './polls-config';

export interface CostDefault {
  hotelShareEur: number;
  flightEur: number;
  otherEur: number;
}

export interface ChosenHotelMeta {
  name?: string;
  totalPriceEur?: number;
}

export interface FlightProposalCache {
  proposals?: Array<{ priceEur?: number }>;
}

/**
 * Pure helper — does not touch the DO directly. Caller pre-fetches:
 *   - chosenHotelRaw: result of `stub.getMeta('chosen_hotel')` (string | null)
 *   - flightCacheByToken: map of `token → stub.getCached('flights:<token>')`
 *     (string | null per token)
 *
 * Returns a Map keyed by participant token; every poll.participants entry has
 * an entry (no missing keys), so callers can iterate the participants list
 * and `.get(token)!` safely.
 */
export function computeDefaultsForPoll(
  poll: Pick<Poll, 'participants'>,
  chosenHotelRaw: string | null,
  flightCacheByToken: Map<string, string | null>
): Map<string, CostDefault> {
  const participantCount = Math.max(1, poll.participants.length);

  // Hotel share — total / N, rounded UP (so we don't under-collect by 1-2 EUR).
  let hotelShareEur = 0;
  if (chosenHotelRaw) {
    try {
      const meta = JSON.parse(chosenHotelRaw) as ChosenHotelMeta;
      const total = Number(meta?.totalPriceEur);
      if (Number.isFinite(total) && total > 0) {
        hotelShareEur = Math.ceil(total / participantCount);
      }
    } catch {
      hotelShareEur = 0;
    }
  }

  const result = new Map<string, CostDefault>();
  for (const p of poll.participants) {
    let flightEur = 0;
    const raw = flightCacheByToken.get(p.token) ?? null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as FlightProposalCache;
        const cheapest = parsed?.proposals?.[0]?.priceEur;
        if (typeof cheapest === 'number' && Number.isFinite(cheapest) && cheapest > 0) {
          flightEur = Math.ceil(cheapest);
        }
      } catch {
        flightEur = 0;
      }
    }
    result.set(p.token, {
      hotelShareEur,
      flightEur,
      otherEur: 0,
    });
  }
  return result;
}
