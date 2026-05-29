// worker/lib/destinations.ts
// Phase 5 — resolve a free-form destination string (poll.destination) into an
// IATA airport code that Amadeus accepts.
//
// Lookup strategy: take everything BEFORE the first comma, lowercase, and look
// up in cities-to-airports.json. If the leading segment doesn't hit, try the
// full lowercased string. Returns null when nothing matches — callers surface
// reason: 'destination_unmapped' in that case.
//
// The mapping table is intentionally small + hand-curated (~100 cities). For
// uncommon destinations the organiser can override via poll.destinationIata
// (handled at the caller layer, not here).

import citiesToAirports from '../../src/data/cities-to-airports.json' with { type: 'json' };

interface CitiesToAirportsFile {
  _doc?: string;
  cities: Record<string, string>;
}

const TABLE = (citiesToAirports as unknown as CitiesToAirportsFile).cities;

/**
 * Free-form destination string → IATA code. Null on miss.
 *
 * Examples:
 *   "Copenhagen, Denmark"       → "CPH"
 *   "munich"                    → "MUC"
 *   "Tokyo, Japan"              → "HND"
 *   "Some obscure village"      → null
 */
export function resolveDestinationIata(destination: string): string | null {
  if (!destination || typeof destination !== 'string') return null;
  const trimmed = destination.trim();
  if (!trimmed) return null;

  // 1. Leading segment before any comma. Most common case for our poll inputs.
  const leadSegment = trimmed.split(',')[0]?.trim().toLowerCase() ?? '';
  if (leadSegment && TABLE[leadSegment]) {
    return TABLE[leadSegment];
  }

  // 2. Full lowercased string — covers single-word inputs that include
  //    punctuation we'd otherwise lose.
  const full = trimmed.toLowerCase();
  if (TABLE[full]) {
    return TABLE[full];
  }

  return null;
}

/**
 * Reverse-lookup helper for UI hints: given an IATA code, find a display city
 * name from the table. Linear scan (table is small). Null on miss.
 */
export function cityForIata(iata: string): string | null {
  if (!iata) return null;
  const upper = iata.toUpperCase();
  for (const [city, code] of Object.entries(TABLE)) {
    if (code === upper) {
      // Capitalize first letter of each word for display.
      return city
        .split(' ')
        .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
        .join(' ');
    }
  }
  return null;
}
