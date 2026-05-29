// worker/lib/flight-provider-mock.ts
// Phase 5 — deterministic mock flight provider.
//
// Goal: same (originIata, destinationIata, departDate) → same flights every
// call, so downstream caching + smoke tests behave like a real backend.
// Realistic enough that the email render, refresh button, admin summary,
// T-30 refresh, and pay-me-back cost-split all behave like they would
// against a live provider — without burning any API quota.
//
// Determinism: RNG is seeded from a 32-bit hash of
// `originIata|destinationIata|departDate`, then run through mulberry32.
//
// What we plausibly fake:
//   - airline mix selected from the regional pool of the origin
//   - 4-7 options (1-3 direct + the rest 1-stop), spread across the day
//   - price scaled by great-circle distance using a tiny IATA → lat/lon table
//   - durations roughly proportional to distance (~800 km/h cruise)
//   - bookingHint flags DEMO data
//   - ALL options carry source: 'mock'

import type {
  FlightOption,
  FlightProvider,
  FlightSearchInput,
  FlightSearchResult,
} from './flight-provider.ts';

// ─── deterministic PRNG ───────────────────────────────────────────────────

/** djb2-style 32-bit hash. Stable, no external deps. */
function hash32(s: string): number {
  let h = 5381 | 0;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  }
  // force unsigned
  return h >>> 0;
}

/**
 * mulberry32 — small, fast, well-distributed 32-bit RNG. Deterministic from
 * seed. Returns floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── geographic + airline data ────────────────────────────────────────────

/** Tiny lat/lon lookup for the airports we ship in cities-to-airports.json.
 *  Used purely for distance-based price/duration scaling — not exhaustive,
 *  but covers every IATA in our mapping so distances are non-zero. */
const AIRPORT_GEO: Record<string, [number, number]> = {
  // Europe
  CPH: [55.62, 12.66], ARN: [59.65, 17.92], OSL: [60.19, 11.10], HEL: [60.32, 24.96],
  KEF: [63.99, -22.61], BER: [52.36, 13.50], MUC: [48.35, 11.79], HAM: [53.63, 9.99],
  FRA: [50.04, 8.55], CGN: [50.86, 7.14], DUS: [51.28, 6.77], STR: [48.69, 9.22],
  VIE: [48.11, 16.57], SZG: [47.79, 13.00], ZRH: [47.46, 8.55], GVA: [46.24, 6.11],
  BSL: [47.59, 7.53], AMS: [52.31, 4.76], RTM: [51.95, 4.44], BRU: [50.90, 4.48],
  CDG: [49.01, 2.55], LYS: [45.72, 5.09], MRS: [43.44, 5.21], NCE: [43.66, 7.21],
  BOD: [44.83, -0.71], TLS: [43.63, 1.36], LHR: [51.47, -0.45], EDI: [55.95, -3.37],
  MAN: [53.36, -2.27], BHX: [52.45, -1.74], GLA: [55.87, -4.43], DUB: [53.42, -6.27],
  ORK: [51.84, -8.49], BCN: [41.30, 2.08], MAD: [40.49, -3.57], SVQ: [37.42, -5.90],
  VLC: [39.49, -0.48], AGP: [36.67, -4.50], PMI: [39.55, 2.74], IBZ: [38.87, 1.37],
  LIS: [38.77, -9.13], OPO: [41.24, -8.68], FCO: [41.80, 12.25], MXP: [45.63, 8.72],
  FLR: [43.81, 11.20], VCE: [45.51, 12.35], NAP: [40.88, 14.29], BLQ: [44.53, 11.29],
  ATH: [37.94, 23.94], JTR: [36.40, 25.48], JMK: [37.43, 25.35], SKG: [40.52, 22.97],
  PRG: [50.10, 14.26], BUD: [47.44, 19.26], WAW: [52.17, 20.97], KRK: [50.08, 19.79],
  OTP: [44.57, 26.10], SOF: [42.69, 23.41], BEG: [44.82, 20.31], ZAG: [45.74, 16.07],
  SPU: [43.54, 16.30], DBV: [42.56, 18.27], LJU: [46.22, 14.46], IST: [41.27, 28.74],
  ESB: [40.13, 32.99], AYT: [36.90, 30.79], TLV: [32.01, 34.89],
  // Africa + ME
  RAK: [31.61, -8.04], CMN: [33.37, -7.59], CAI: [30.11, 31.40], CPT: [-33.97, 18.60],
  JNB: [-26.13, 28.24], DXB: [25.25, 55.36], AUH: [24.43, 54.65], DOH: [25.27, 51.61],
  // North America
  JFK: [40.64, -73.78], BOS: [42.36, -71.01], IAD: [38.95, -77.46], ORD: [41.98, -87.91],
  LAX: [33.94, -118.41], SFO: [37.62, -122.38], SEA: [47.45, -122.31], MIA: [25.79, -80.29],
  LAS: [36.08, -115.15], DEN: [39.86, -104.67], ATL: [33.64, -84.43], IAH: [29.98, -95.34],
  DFW: [32.90, -97.04], PHL: [39.87, -75.24], YYZ: [43.68, -79.63], YVR: [49.19, -123.18],
  YUL: [45.47, -73.74], MEX: [19.44, -99.07], HAV: [22.99, -82.41], SJO: [9.99, -84.21],
  PTY: [9.07, -79.38], BOG: [4.70, -74.15], LIM: [-12.02, -77.11], GIG: [-22.81, -43.25],
  GRU: [-23.43, -46.47], EZE: [-34.82, -58.54], SCL: [-33.39, -70.79],
  // Asia + Pacific
  HND: [35.55, 139.78], KIX: [34.43, 135.24], ITM: [34.79, 135.44], ICN: [37.46, 126.44],
  PEK: [40.08, 116.58], PVG: [31.14, 121.81], HKG: [22.31, 113.92], TPE: [25.08, 121.23],
  BKK: [13.69, 100.75], HKT: [8.11, 98.31], CNX: [18.77, 98.96], SGN: [10.82, 106.66],
  HAN: [21.22, 105.81], SIN: [1.36, 103.99], KUL: [2.74, 101.71], DPS: [-8.75, 115.17],
  CGK: [-6.13, 106.66], MNL: [14.51, 121.02], DEL: [28.57, 77.10], BOM: [19.09, 72.87],
  BLR: [13.20, 77.71], CCU: [22.65, 88.45], SYD: [-33.94, 151.18], MEL: [-37.67, 144.84],
  BNE: [-27.38, 153.12], PER: [-31.94, 115.97], AKL: [-37.01, 174.79], WLG: [-41.33, 174.81],
};

/** Region buckets for picking plausible airlines per route. */
type Region = 'europe' | 'north_america' | 'asia_pacific' | 'middle_east' | 'africa' | 'south_america';
const AIRPORT_REGION: Record<string, Region> = {};
for (const code of [
  'CPH','ARN','OSL','HEL','KEF','BER','MUC','HAM','FRA','CGN','DUS','STR','VIE','SZG',
  'ZRH','GVA','BSL','AMS','RTM','BRU','CDG','LYS','MRS','NCE','BOD','TLS','LHR','EDI',
  'MAN','BHX','GLA','DUB','ORK','BCN','MAD','SVQ','VLC','AGP','PMI','IBZ','LIS','OPO',
  'FCO','MXP','FLR','VCE','NAP','BLQ','ATH','JTR','JMK','SKG','PRG','BUD','WAW','KRK',
  'OTP','SOF','BEG','ZAG','SPU','DBV','LJU','IST','ESB','AYT',
]) AIRPORT_REGION[code] = 'europe';
for (const code of ['JFK','BOS','IAD','ORD','LAX','SFO','SEA','MIA','LAS','DEN','ATL','IAH','DFW','PHL','YYZ','YVR','YUL','MEX','HAV','SJO','PTY']) AIRPORT_REGION[code] = 'north_america';
for (const code of ['HND','KIX','ITM','ICN','PEK','PVG','HKG','TPE','BKK','HKT','CNX','SGN','HAN','SIN','KUL','DPS','CGK','MNL','DEL','BOM','BLR','CCU','SYD','MEL','BNE','PER','AKL','WLG']) AIRPORT_REGION[code] = 'asia_pacific';
for (const code of ['TLV','DXB','AUH','DOH']) AIRPORT_REGION[code] = 'middle_east';
for (const code of ['RAK','CMN','CAI','CPT','JNB']) AIRPORT_REGION[code] = 'africa';
for (const code of ['BOG','LIM','GIG','GRU','EZE','SCL']) AIRPORT_REGION[code] = 'south_america';

const AIRLINES_BY_REGION: Record<Region, Array<[string, string]>> = {
  europe: [
    ['LH', 'Lufthansa'], ['SK', 'SAS'], ['KL', 'KLM'], ['AF', 'Air France'],
    ['BA', 'British Airways'], ['IB', 'Iberia'], ['LX', 'SWISS'], ['OS', 'Austrian'],
    ['AY', 'Finnair'], ['AZ', 'ITA Airways'], ['TP', 'TAP Air Portugal'],
    ['LO', 'LOT'], ['A3', 'Aegean'], ['TK', 'Turkish Airlines'],
  ],
  north_america: [
    ['DL', 'Delta'], ['UA', 'United'], ['AA', 'American Airlines'],
    ['AC', 'Air Canada'], ['B6', 'JetBlue'], ['AS', 'Alaska Airlines'],
    ['WN', 'Southwest'],
  ],
  asia_pacific: [
    ['SQ', 'Singapore Airlines'], ['CX', 'Cathay Pacific'], ['QF', 'Qantas'],
    ['NZ', 'Air New Zealand'], ['JL', 'Japan Airlines'], ['NH', 'ANA'],
    ['KE', 'Korean Air'], ['OZ', 'Asiana'], ['TG', 'Thai Airways'],
    ['MH', 'Malaysia Airlines'], ['CI', 'China Airlines'], ['CA', 'Air China'],
    ['AI', 'Air India'],
  ],
  middle_east: [
    ['EK', 'Emirates'], ['QR', 'Qatar Airways'], ['EY', 'Etihad'], ['LY', 'El Al'],
  ],
  africa: [
    ['ET', 'Ethiopian Airlines'], ['MS', 'EgyptAir'], ['SA', 'South African Airways'],
    ['AT', 'Royal Air Maroc'], ['KQ', 'Kenya Airways'],
  ],
  south_america: [
    ['LA', 'LATAM'], ['G3', 'GOL'], ['AD', 'Azul'], ['AR', 'Aerolíneas Argentinas'],
    ['AV', 'Avianca'],
  ],
};

/** Great-circle distance between two lat/lon pairs (km), haversine. */
function distanceKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Pick the airline pool to draw from for this origin → destination route. */
function airlinePoolFor(origin: string, destination: string): Array<[string, string]> {
  const ro = AIRPORT_REGION[origin];
  const rd = AIRPORT_REGION[destination];
  // Same-region: pool is the home region. Cross-region: blend both pools so
  // results include a mix of origin + destination national carriers.
  if (ro && rd && ro === rd) return AIRLINES_BY_REGION[ro];
  const pool: Array<[string, string]> = [];
  if (ro) pool.push(...AIRLINES_BY_REGION[ro]);
  if (rd) pool.push(...AIRLINES_BY_REGION[rd]);
  if (pool.length === 0) return AIRLINES_BY_REGION.europe; // safe default
  // De-dupe by carrier code.
  const seen = new Set<string>();
  return pool.filter(([code]) => {
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

/** Format HH:MM from a fractional hour-of-day (0..24). */
function fmtHHMM(hoursFloat: number): string {
  const h = Math.floor(hoursFloat) % 24;
  const m = Math.floor((hoursFloat - Math.floor(hoursFloat)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Add minutes to an "HH:MM" + ISO-date and return same-day "HH:MM" string. */
function addMinutesHHMM(base: string, mins: number): string {
  const [h, m] = base.split(':').map(Number);
  const total = h * 60 + m + mins;
  const totalDay = ((total % 1440) + 1440) % 1440;
  return fmtHHMM(totalDay / 60);
}

/** Mulberry32-driven integer in [lo, hi] inclusive. */
function randInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

export class MockFlightProvider implements FlightProvider {
  readonly name = 'mock';
  readonly isReal = false;

  async searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
    const origin = (input.originIata ?? '').toUpperCase();
    const destination = (input.destinationIata ?? '').toUpperCase();
    const depart = input.departDate ?? '';
    const currency = input.currency ?? 'EUR';

    if (!origin) return { flights: [], reason: 'profile_incomplete' };
    if (!destination) return { flights: [], reason: 'destination_unmapped' };
    if (origin === destination) return { flights: [], reason: 'no_routes' };

    // Distance — fall back to a mid-haul guess when we don't know one of the
    // airports (still deterministic via the seed below).
    let km: number;
    const a = AIRPORT_GEO[origin];
    const b = AIRPORT_GEO[destination];
    if (a && b) {
      km = distanceKm(a, b);
    } else {
      km = 1500;
    }

    const seed = hash32(`${origin}|${destination}|${depart}`);
    const rng = mulberry32(seed);

    // Number of options: 4-7. Direct count: 1-3, rest = 1-stop.
    const nOptions = randInt(rng, 4, 7);
    const directCount = Math.min(nOptions, randInt(rng, 1, 3));

    // Base price scales with distance (short-haul €60-€250, medium €150-€500,
    // long-haul €450-€1500 per CONTEXT). Use a piecewise linear curve + 20%
    // jitter per option.
    let basePrice: number;
    if (km < 1200) basePrice = 60 + (km / 1200) * 190;            // 60..250
    else if (km < 4000) basePrice = 150 + ((km - 1200) / 2800) * 350; // 150..500
    else basePrice = 450 + Math.min(1, (km - 4000) / 8000) * 1050;     // 450..1500

    // Cruise speed ~800 km/h + 45 min ground time + per-stop layover.
    const directMin = Math.max(60, Math.round(45 + (km / 800) * 60));

    const pool = airlinePoolFor(origin, destination);
    // Pick (nOptions) airlines, deterministically. Sample without replacement
    // until pool runs out, then with replacement.
    const picks: Array<[string, string]> = [];
    const remaining = [...pool];
    for (let i = 0; i < nOptions; i++) {
      if (remaining.length > 0) {
        const idx = randInt(rng, 0, remaining.length - 1);
        picks.push(remaining[idx]);
        remaining.splice(idx, 1);
      } else {
        picks.push(pool[randInt(rng, 0, pool.length - 1)]);
      }
    }

    // Spread departures across the day: morning (5-10h), midday (10-15h),
    // evening (15-22h). Each option gets a slot.
    const slots = [
      [5, 10],
      [7, 12],
      [10, 14],
      [13, 17],
      [15, 19],
      [17, 21],
      [19, 22],
    ];

    const flights: FlightOption[] = [];
    for (let i = 0; i < nOptions; i++) {
      const [code, name] = picks[i];
      const isDirect = i < directCount;
      const stops = isDirect ? 0 : randInt(rng, 1, 2);
      // Stops add 90-180 min per layover.
      const layoverMin = stops * randInt(rng, 90, 180);
      const durationMinTotal = directMin + layoverMin;

      // Price: direct flights skew higher (premium), stops cheaper.
      const stopDiscount = stops === 0 ? 1.0 : stops === 1 ? 0.82 : 0.7;
      const jitter = 0.85 + rng() * 0.3; // 0.85..1.15
      const priceEur = Math.round(basePrice * stopDiscount * jitter);

      const slot = slots[i % slots.length];
      const departHour = slot[0] + rng() * (slot[1] - slot[0]);
      const departureTimeLocal = `${depart}T${fmtHHMM(departHour)}:00`;
      const arrivalHHMM = addMinutesHHMM(fmtHHMM(departHour), durationMinTotal);
      // We don't bother modelling next-day arrival visually — same ISO date.
      const arrivalTimeLocal = `${depart}T${arrivalHHMM}:00`;

      // Flight number 100..999, deterministic.
      const flightNum = randInt(rng, 100, 999);
      const bookingHint =
        `DEMO DATA — search '${code} ${flightNum}' or '${origin}→${destination}' on Google Flights for real options.`;

      flights.push({
        airline: name,
        carrierCode: code,
        durationMinTotal,
        stops,
        priceEur,
        priceCurrency: currency,
        departureTimeLocal,
        arrivalTimeLocal,
        bookingHint,
        source: 'mock',
      });
    }

    // Sort cheapest first, ties broken by shorter duration (matches the
    // contract the previous Amadeus impl gave to callers).
    flights.sort((x, y) => {
      if (x.priceEur !== y.priceEur) return x.priceEur - y.priceEur;
      return x.durationMinTotal - y.durationMinTotal;
    });

    return { flights, reason: 'ok' };
  }
}
