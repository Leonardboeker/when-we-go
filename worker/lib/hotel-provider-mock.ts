// worker/lib/hotel-provider-mock.ts
// Phase 6 — deterministic mock hotel provider.
//
// Goal: same (destinationIata, checkInDate, checkOutDate, guests) → same
// hotel shortlist every call, so downstream caching + smoke tests behave
// like a real backend. Realistic enough that the email render, refresh
// button, admin choose flow, organiser-vote tallies and pay-me-back
// cost-split all behave like they would against a live provider — without
// burning any API quota.
//
// Determinism: RNG is seeded from a 32-bit djb2 hash of
// `destinationIata|checkInDate|checkOutDate|guests`, then run through
// mulberry32.
//
// What we plausibly fake:
//   - 5-8 hotels per query
//   - Name templates blended from chain-style + boutique pools
//   - Star distribution skewed to 3-4 with occasional 2 + 5
//   - Distance to centre 0.3-4.5 km
//   - Nightly price scaled by destination "tier" (tier1 capitals dearer)
//   - perPerson = ceil(total / guests)
//   - Amenity mix drawn from {wifi, breakfast, pool, gym, bar, ac, kitchen, laundry}
//   - bookingHint flags DEMO data + suggests a Booking.com lookup string
//   - ALL options carry source: 'mock'

import type {
  HotelOption,
  HotelProvider,
  HotelSearchInput,
  HotelSearchResult,
} from './hotel-provider.ts';

// ─── deterministic PRNG (same primitives as flight mock) ──────────────────

/** djb2-style 32-bit hash. Stable, no external deps. */
function hash32(s: string): number {
  let h = 5381 | 0;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, well-distributed 32-bit RNG. */
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

/** Mulberry32-driven integer in [lo, hi] inclusive. */
function randInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

/** Mulberry32-driven float in [lo, hi). */
function randFloat(rng: () => number, lo: number, hi: number): number {
  return rng() * (hi - lo) + lo;
}

// ─── price tiers + name templates ─────────────────────────────────────────

/** Destinations are bucketed into tiers — tier1 capitals are pricier than
 *  secondary city breaks. Anything not listed defaults to tier 'mid'. */
type Tier = 'top' | 'mid' | 'cheap';
const TIER_OVERRIDES: Record<string, Tier> = {
  // top — Northern Europe capitals + global trophy cities
  CPH: 'top', OSL: 'top', STO: 'top', ARN: 'top', HEL: 'top',
  ZRH: 'top', GVA: 'top', CDG: 'top', LHR: 'top', LCY: 'top',
  NCE: 'top', AMS: 'top', MUC: 'top', FRA: 'top',
  JFK: 'top', SFO: 'top', LAX: 'top', BOS: 'top', YYZ: 'top',
  HND: 'top', NRT: 'top', ICN: 'top', SIN: 'top', HKG: 'top',
  SYD: 'top', MEL: 'top', DXB: 'top', AUH: 'top', DOH: 'top',
  TLV: 'top', BER: 'top', VIE: 'top', BRU: 'top', DUB: 'top',
  // cheap — Eastern Europe, parts of SE Asia / South America
  WAW: 'cheap', KRK: 'cheap', BUD: 'cheap', PRG: 'cheap',
  OTP: 'cheap', SOF: 'cheap', BEG: 'cheap', SKG: 'cheap',
  BKK: 'cheap', HAN: 'cheap', SGN: 'cheap', CGK: 'cheap',
  KUL: 'cheap', DEL: 'cheap', BOM: 'cheap', BLR: 'cheap',
  GIG: 'cheap', GRU: 'cheap', LIM: 'cheap', BOG: 'cheap',
  RAK: 'cheap', CMN: 'cheap', CAI: 'cheap',
  // (everything else falls through to 'mid')
};

interface TierBand {
  /** Nightly EUR range for a "median" stay (3-star equivalent). */
  base: [number, number];
  /** Multiplier vs stars rating: lower = cheap hostel, higher = boutique 5-star. */
  starMul: Record<number, [number, number]>;
}

const TIER_BANDS: Record<Tier, TierBand> = {
  top: {
    base: [120, 240],
    starMul: {
      2: [0.55, 0.75],
      3: [0.85, 1.10],
      4: [1.25, 1.60],
      5: [1.80, 2.40],
    },
  },
  mid: {
    base: [75, 150],
    starMul: {
      2: [0.55, 0.80],
      3: [0.90, 1.10],
      4: [1.25, 1.55],
      5: [1.70, 2.10],
    },
  },
  cheap: {
    base: [40, 90],
    starMul: {
      2: [0.55, 0.85],
      3: [0.90, 1.15],
      4: [1.30, 1.60],
      5: [1.80, 2.20],
    },
  },
};

function tierForDestination(iata: string): Tier {
  return TIER_OVERRIDES[iata.toUpperCase()] ?? 'mid';
}

/** Star-distribution weights — order matters for the deterministic sampler.
 *  Skew to 3-4 with an occasional 2 + 5. */
const STAR_WEIGHTS: Array<[number, number]> = [
  [2, 0.15],
  [3, 0.40],
  [4, 0.35],
  [5, 0.10],
];

function pickWeighted<T>(rng: () => number, items: Array<[T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [item, w] of items) {
    if (r < w) return item;
    r -= w;
  }
  return items[items.length - 1][0];
}

/** Title-case a city slug like "kuala lumpur" → "Kuala Lumpur". */
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Name template fragments — combined by the RNG. Some are chain-style,
 *  some boutique-style; the mix shifts with stars. */
const CHAIN_PREFIXES = ['Hotel', 'Park', 'Grand', 'Royal', 'Best Western', 'Comfort', 'Premier'];
const CHAIN_SUFFIXES = ['Plaza', 'Inn', 'Garden', 'Central', 'Riverside', 'Towers', 'Suites'];
const BOUTIQUE_PREFIXES = ['Casa', 'Maison', 'Villa', 'The', 'Loft', 'Studio', 'Atelier'];
const BOUTIQUE_SUFFIXES = ['Boutique', 'Rooftop', 'Loft', 'House', 'Quarters', 'Residences'];
const HOSTEL_PREFIXES = ['Generator', 'Wombat\'s', 'Selina', 'Hostel', 'St Christopher\'s'];
const HOSTEL_SUFFIXES = ['Central', 'Old Town', 'Downtown', 'Riverside'];

function hotelNameFor(
  rng: () => number,
  cityDisplay: string,
  stars: number
): string {
  // 2-star → mostly hostel/budget; 5-star → boutique; 3-4 → chain mix
  if (stars <= 2) {
    const prefix = HOSTEL_PREFIXES[randInt(rng, 0, HOSTEL_PREFIXES.length - 1)];
    const suffix = HOSTEL_SUFFIXES[randInt(rng, 0, HOSTEL_SUFFIXES.length - 1)];
    return `${prefix} ${cityDisplay} ${suffix}`;
  }
  if (stars >= 5) {
    const prefix = BOUTIQUE_PREFIXES[randInt(rng, 0, BOUTIQUE_PREFIXES.length - 1)];
    const suffix = BOUTIQUE_SUFFIXES[randInt(rng, 0, BOUTIQUE_SUFFIXES.length - 1)];
    // Mix in city name occasionally for variety
    return rng() < 0.5
      ? `${prefix} ${cityDisplay} ${suffix}`
      : `${prefix} ${suffix} ${cityDisplay}`;
  }
  // 3-4 star — chain style
  const prefix = CHAIN_PREFIXES[randInt(rng, 0, CHAIN_PREFIXES.length - 1)];
  const suffix = CHAIN_SUFFIXES[randInt(rng, 0, CHAIN_SUFFIXES.length - 1)];
  return `${prefix} ${cityDisplay} ${suffix}`;
}

const ALL_AMENITIES = [
  'wifi',
  'breakfast',
  'pool',
  'gym',
  'bar',
  'ac',
  'kitchen',
  'laundry',
];

function pickAmenities(rng: () => number, stars: number): string[] {
  // Higher stars → more amenities. wifi always included (this is 2026).
  const set = new Set<string>(['wifi']);
  const target = stars <= 2 ? 2 : stars === 3 ? 3 : stars === 4 ? 4 : 5;
  let safety = 0;
  while (set.size < target && safety < 20) {
    set.add(ALL_AMENITIES[randInt(rng, 0, ALL_AMENITIES.length - 1)]);
    safety++;
  }
  return Array.from(set);
}

/** Inclusive checkIn, exclusive checkOut → number of paid nights.
 *  Returns 1 minimum so 0-night queries still produce a valid price. */
function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn + 'T00:00:00Z');
  const b = Date.parse(checkOut + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  const diffDays = Math.round((b - a) / 86_400_000);
  return Math.max(1, diffDays);
}

export class MockHotelProvider implements HotelProvider {
  readonly name = 'mock';
  readonly isReal = false;

  async searchHotels(input: HotelSearchInput): Promise<HotelSearchResult> {
    const destinationIata = (input.destinationIata ?? '').toUpperCase();
    const checkIn = input.checkInDate ?? '';
    const checkOut = input.checkOutDate ?? '';
    const guests = Math.max(1, Math.floor(input.guests ?? 1));
    const cityDisplay = titleCase(
      input.destinationCity?.trim() || destinationIata || 'City'
    );

    if (!destinationIata) {
      return { hotels: [], reason: 'destination_unmapped' };
    }

    const seed = hash32(`${destinationIata}|${checkIn}|${checkOut}|${guests}`);
    const rng = mulberry32(seed);

    const tier = tierForDestination(destinationIata);
    const band = TIER_BANDS[tier];

    const nights = nightsBetween(checkIn, checkOut);
    const nOptions = randInt(rng, 5, 8);

    const hotels: HotelOption[] = [];
    for (let i = 0; i < nOptions; i++) {
      const stars = pickWeighted(rng, STAR_WEIGHTS);
      const starMul = band.starMul[stars] ?? [1, 1];
      const baseNight = randFloat(rng, band.base[0], band.base[1]);
      const mul = randFloat(rng, starMul[0], starMul[1]);
      const nightlyPriceEur = Math.round(baseNight * mul);
      const totalPriceEur = nightlyPriceEur * nights;
      const perPersonEur = Math.ceil(totalPriceEur / guests);

      const distanceToCenterKm = Math.round(randFloat(rng, 0.3, 4.5) * 10) / 10;
      const name = hotelNameFor(rng, cityDisplay, stars);
      // Deterministic per-hotel id — include index so duplicates don't collide.
      const idSuffix = (hash32(`${name}|${i}|${seed}`) >>> 0).toString(36);
      const hotelId = `mock-${destinationIata.toLowerCase()}-${idSuffix}`;

      const amenities = pickAmenities(rng, stars);

      const bookingHint =
        `DEMO DATA — search '${name} ${cityDisplay}' on Booking.com for real options.`;

      // Unsplash photo by star tier — deterministic pick from a small pool.
      const HOTEL_PHOTOS: Record<string, string[]> = {
        '5': [
          'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&h=340&fit=crop',
          'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=600&h=340&fit=crop',
          'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=600&h=340&fit=crop',
        ],
        '4': [
          'https://images.unsplash.com/photo-1455587734955-081b22074882?w=600&h=340&fit=crop',
          'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&h=340&fit=crop',
          'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=600&h=340&fit=crop',
        ],
        '3': [
          'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=600&h=340&fit=crop',
          'https://images.unsplash.com/photo-1497436072909-60f360e1d4b1?w=600&h=340&fit=crop',
        ],
        '2': [
          'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=340&fit=crop',
        ],
      };
      const photoPool = HOTEL_PHOTOS[String(stars)] ?? HOTEL_PHOTOS['3'];
      const imageUrl = photoPool[randInt(rng, 0, photoPool.length - 1)];

      // Booking.com search link pre-filled with hotel name + dates + guests.
      const checkinFmt = checkIn.replace(/-/g, '-');
      const checkoutFmt = checkOut.replace(/-/g, '-');
      const bookingUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(name + ' ' + cityDisplay)}&checkin=${checkinFmt}&checkout=${checkoutFmt}&group_adults=${guests}&no_rooms=1`;

      hotels.push({
        hotelId,
        name,
        stars,
        distanceToCenterKm,
        imageUrl,
        bookingUrl,
        totalPriceEur,
        nightlyPriceEur,
        perPersonEur,
        amenities,
        bookingHint,
        source: 'mock',
      });
    }

    // Sort cheapest perPerson first; ties broken by stars DESC then name ASC
    // so the same list orders identically across calls.
    hotels.sort((a, b) => {
      if (a.perPersonEur !== b.perPersonEur) return a.perPersonEur - b.perPersonEur;
      if (a.stars !== b.stars) return b.stars - a.stars;
      return a.name.localeCompare(b.name);
    });

    return { hotels, reason: 'ok' };
  }
}
