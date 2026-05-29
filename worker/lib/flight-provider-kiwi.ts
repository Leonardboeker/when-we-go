// worker/lib/flight-provider-kiwi.ts
// Phase 5 — Kiwi.com Tequila real flight provider.
//
// Tequila is Kiwi's free self-serve API. Free tier: 1000 req/day, no CC needed.
// Sign up at https://tequila.kiwi.com/portal/login → create API key → add as
// WHENWEGO_KIWI_API_KEY worker secret.
//
// Why Tequila over Amadeus: Amadeus Self-Service is decommissioned 2026-07-17.
// Tequila has no announced decommission, is genuinely free, and covers the
// European routes this app targets well (Ryanair, EasyJet, etc.).
//
// API base: https://api.tequila.kiwi.com/v2/search
// Auth: apikey header
// Full docs: https://tequila.kiwi.com/portal/docs/tequila-api

import type {
  FlightOption,
  FlightProvider,
  FlightSearchInput,
  FlightSearchResult,
} from './flight-provider.ts';

// ─── carrier name map ────────────────────────────────────────────────────────

const CARRIER_NAMES: Record<string, string> = {
  FR: 'Ryanair',
  U2: 'easyJet',
  LH: 'Lufthansa',
  W6: 'Wizz Air',
  VY: 'Vueling',
  IB: 'Iberia',
  BA: 'British Airways',
  AF: 'Air France',
  KL: 'KLM',
  DY: 'Norwegian',
  HV: 'Transavia',
  SK: 'SAS',
  EW: 'Eurowings',
  LX: 'Swiss',
  TP: 'TAP Air Portugal',
  EI: 'Aer Lingus',
  AY: 'Finnair',
  LO: 'LOT',
  LS: 'Jet2',
  BY: 'TUI Airways',
  OS: 'Austrian',
  BT: 'airBaltic',
  PS: 'Ukraine International',
  BV: 'Blue Air',
  V7: 'Volotea',
  '0B': 'Blue Air',
};

function carrierName(code: string): string {
  return CARRIER_NAMES[code.toUpperCase()] ?? code;
}

// ─── Tequila API response shapes ─────────────────────────────────────────────

interface TequilaRoute {
  airline: string;
  local_departure: string;
  local_arrival: string;
}

interface TequilaFlight {
  id: string;
  airlines: string[];
  price: number;
  duration: {
    departure: number; // seconds
    return?: number;   // seconds, 0 or absent for one-way
  };
  local_departure: string; // ISO at origin
  local_arrival: string;   // ISO at destination
  route: TequilaRoute[];
  booking_token: string;
}

interface TequilaResponse {
  data: TequilaFlight[];
}

// ─── date helpers ─────────────────────────────────────────────────────────────

/** Convert ISO YYYY-MM-DD to DD/MM/YYYY required by Tequila. */
function toTequilaDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Count stops from the route array (segments - 1, clamp to non-negative). */
function countStops(route: TequilaRoute[]): number {
  return Math.max(0, route.length - 1);
}

// ─── provider ─────────────────────────────────────────────────────────────────

export class KiwiFlightProvider implements FlightProvider {
  readonly name = 'kiwi';
  readonly isReal = true;

  constructor(private readonly apiKey: string) {}

  async searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
    const {
      originIata,
      destinationIata,
      departDate,
      returnDate,
    } = input;

    const params = new URLSearchParams({
      fly_from: originIata,
      fly_to: destinationIata,
      date_from: toTequilaDate(departDate),
      date_to: toTequilaDate(departDate),
      curr: 'EUR',
      limit: '6',
      sort: 'price',
      vehicle_type: 'aircraft',
    });

    if (returnDate) {
      params.set('return_from', toTequilaDate(returnDate));
      params.set('return_to', toTequilaDate(returnDate));
    }

    let res: Response;
    try {
      res = await fetch(`https://api.tequila.kiwi.com/v2/search?${params}`, {
        headers: {
          apikey: this.apiKey,
          accept: 'application/json',
        },
      });
    } catch (err) {
      console.error('[kiwi] network error', err);
      return { reason: 'provider_error', flights: [] };
    }

    if (!res.ok) {
      console.error(`[kiwi] HTTP ${res.status} for ${originIata}→${destinationIata}`);
      return { reason: 'provider_error', flights: [] };
    }

    let body: TequilaResponse;
    try {
      body = (await res.json()) as TequilaResponse;
    } catch (err) {
      console.error('[kiwi] JSON parse error', err);
      return { reason: 'provider_error', flights: [] };
    }

    if (!body.data || body.data.length === 0) {
      return { reason: 'no_routes', flights: [] };
    }

    const flights: FlightOption[] = body.data.map((f) => {
      const carrierCode = f.airlines[0] ?? 'XX';
      const depSec = f.duration.departure ?? 0;
      const retSec = f.duration.return ?? 0;
      const durationMinTotal = Math.round((depSec + retSec) / 60);

      return {
        airline: carrierName(carrierCode),
        carrierCode,
        durationMinTotal,
        stops: countStops(f.route),
        priceEur: Math.round(f.price),
        priceCurrency: 'EUR',
        departureTimeLocal: f.local_departure,
        arrivalTimeLocal: f.local_arrival,
        bookingHint: 'Book via Kiwi.com',
        source: 'kiwi',
      };
    });

    return { reason: 'ok', flights };
  }
}
