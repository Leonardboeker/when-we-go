// worker/lib/activity-provider-mock.ts
// Phase 7 — deterministic mock activity provider.
//
// Goal: same (destination, startDate, endDate, participantCount) → same list
// every call, so downstream caching + smoke tests behave like a real backend.
// Hand-curated evergreen highlights for a handful of "trophy" destinations
// (Copenhagen / Barcelona / Paris / Berlin / Tokyo etc.); long-tail
// destinations fall through to a generic template.
//
// All evergreens land in alwaysGreat at confidence:'high' (mock can't know
// what's happening on a specific date, so thisWeek is sparse + confidence
// kept at 'medium' since we're fabricating dates).
//
// Every item carries source:'mock' so the UI flips on the DEMO banner.

import type {
  ActivityItem,
  ActivityList,
  ActivityProvider,
  ActivitySearchInput,
  ActivitySearchResult,
} from './activity-provider.ts';

// ─── deterministic PRNG (same primitives as flight/hotel mock) ────────────

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
    a = (a + 0x6d2b79f5) | 0;
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

// ─── curated evergreen highlights by destination ───────────────────────────

type Evergreen = Omit<ActivityItem, 'source' | 'confidence'> & {
  confidence?: ActivityItem['confidence'];
};

/**
 * Trophy destinations with hand-curated highlights. Match is case-insensitive
 * substring against destination so "Copenhagen, Denmark" still hits "copenhagen".
 */
const CURATED: Record<string, Evergreen[]> = {
  copenhagen: [
    { name: 'Tivoli Gardens', type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 25, whyOneSentence: 'World-famous amusement park in the heart of the city — beautiful at dusk.' },
    { name: 'Nyhavn waterfront walk', type: 'neighborhood', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Iconic colourful 17th-century harbour lined with cafés and restored ships.' },
    { name: 'Louisiana Museum of Modern Art', type: 'museum', dateRange: 'all year', paid: true, priceEur: 22, whyOneSentence: 'A 35-min train ride north — sculpture park by the sea, easily a half-day visit.' },
    { name: 'Christiania free town', type: 'neighborhood', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Self-governed alternative community — graffiti art, music venues, weird food.' },
    { name: 'Smørrebrød lunch at Aamanns', type: 'food', dateRange: 'all year', paid: true, priceEur: 35, whyOneSentence: 'Traditional Danish open-faced sandwiches done by a James Beard finalist.' },
    { name: 'Rosenborg Castle + crown jewels', type: 'history', dateRange: 'all year', paid: true, priceEur: 16, whyOneSentence: 'Renaissance palace with the actual Danish crown jewels in the basement vault.' },
  ],
  barcelona: [
    { name: 'Sagrada Família', type: 'history', dateRange: 'all year', paid: true, priceEur: 26, whyOneSentence: 'Gaudí\'s unfinished basilica — book the timed-entry ticket online to skip the line.' },
    { name: 'Park Güell', type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 10, whyOneSentence: 'Hillside park with mosaic terraces and panoramic city views.' },
    { name: 'Tapas crawl in El Born', type: 'food', dateRange: 'all year', paid: true, priceEur: 35, whyOneSentence: 'Wander between Cal Pep, Bormuth, La Vinya del Senyor — pintxos + cava all night.' },
    { name: 'Gothic Quarter wander', type: 'neighborhood', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Medieval alleys, the cathedral, hidden plaças — best at sunset before dinner.' },
    { name: 'Picasso Museum', type: 'museum', dateRange: 'all year', paid: true, priceEur: 14, whyOneSentence: 'His early work + the Las Meninas series — Thursday evenings are free after 17:00.' },
    { name: 'Beach day at Bogatell', type: 'outdoors', dateRange: 'May-Oct', paid: false, priceEur: null, whyOneSentence: 'Less touristy than Barceloneta, easy metro ride to Poblenou.' },
  ],
  paris: [
    { name: 'Louvre (early entry)', type: 'museum', dateRange: 'all year', paid: true, priceEur: 22, whyOneSentence: 'Book the 09:00 timed slot — first hour is empty around the Mona Lisa.' },
    { name: 'Marais walking tour', type: 'neighborhood', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Falafel at L\'As, vintage shops, Place des Vosges — the best Paris neighborhood for wandering.' },
    { name: 'Boat dinner on the Seine', type: 'food', dateRange: 'all year', paid: true, priceEur: 60, whyOneSentence: 'Bateaux Mouches if you want the cliché; Bateaux Parisiens for slightly better food.' },
    { name: 'Père Lachaise cemetery', type: 'outdoors', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Jim Morrison, Édith Piaf, Oscar Wilde — half a day among Paris history.' },
    { name: 'Musée d\'Orsay', type: 'museum', dateRange: 'all year', paid: true, priceEur: 16, whyOneSentence: 'Impressionists in an old railway station — easier on the feet than the Louvre.' },
    { name: 'Sunset at Sacré-Cœur', type: 'outdoors', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Climb the Montmartre steps for a free view that beats most paid ones.' },
  ],
  berlin: [
    { name: 'East Side Gallery', type: 'history', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: '1.3 km of Berlin Wall covered in murals — go early to beat the crowds.' },
    { name: 'Pergamon Museum (Museum Island)', type: 'museum', dateRange: 'all year', paid: true, priceEur: 14, whyOneSentence: 'Ishtar Gate + Pergamon Altar — book ahead, parts may close for restoration.' },
    { name: 'Currywurst at Curry 36', type: 'food', dateRange: 'all year', paid: true, priceEur: 7, whyOneSentence: 'Local institution next to Mehringdamm U-Bahn — quick, cheap, ridiculous portion.' },
    { name: 'Tiergarten + Brandenburg Gate', type: 'outdoors', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Pleasant 30-min walk through Berlin\'s central park into the historic heart.' },
    { name: 'Berghain (or its garden bar)', type: 'event', dateRange: 'all year', paid: true, priceEur: 25, whyOneSentence: 'Maybe-the-best techno club — dress dark, expect to queue, no phones inside.' },
    { name: 'Mauerpark Sunday flea market', type: 'neighborhood', dateRange: 'Sundays', paid: false, priceEur: null, whyOneSentence: 'Bearpit karaoke at 15:00 + a flea market sprawled across the park.' },
  ],
  tokyo: [
    { name: 'Tsukiji Outer Market breakfast', type: 'food', dateRange: 'all year', paid: true, priceEur: 25, whyOneSentence: 'Sushi + tamagoyaki + dashi-maki for breakfast — go by 09:00 before vendors close.' },
    { name: 'Shibuya Crossing + Sky observation', type: 'neighborhood', dateRange: 'all year', paid: true, priceEur: 18, whyOneSentence: 'Cross the world\'s busiest intersection then watch it from Shibuya Sky at sunset.' },
    { name: 'Senso-ji + Asakusa wander', type: 'history', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Tokyo\'s oldest temple, lantern-lit Nakamise-dori, traditional sweets street-side.' },
    { name: 'TeamLab Borderless or Planets', type: 'museum', dateRange: 'all year', paid: true, priceEur: 25, whyOneSentence: 'Immersive digital art installations — buy tickets a week ahead, they sell out.' },
    { name: 'Shinjuku Golden Gai bar hop', type: 'food', dateRange: 'all year', paid: true, priceEur: 30, whyOneSentence: '200+ tiny bars in 6 alleys; pick ones with English signs to avoid table charges.' },
    { name: 'Day trip to Kamakura', type: 'outdoors', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Great Buddha + bamboo grove + beach, 1h on the Yokosuka line from Tokyo Station.' },
  ],
  lisbon: [
    { name: 'Tram 28 ride through Alfama', type: 'neighborhood', dateRange: 'all year', paid: true, priceEur: 3, whyOneSentence: 'Iconic yellow tram looping through the old town — board at Martim Moniz to get a seat.' },
    { name: 'Pastéis de Belém', type: 'food', dateRange: 'all year', paid: true, priceEur: 2, whyOneSentence: 'The original pastel de nata since 1837 — the queue moves fast, take-away is faster.' },
    { name: 'Time Out Market', type: 'food', dateRange: 'all year', paid: true, priceEur: 25, whyOneSentence: 'Curated food hall — try Marlene Vieira or Henrique Sá Pessoa for a stand-up tasting menu.' },
    { name: 'Castelo de São Jorge', type: 'history', dateRange: 'all year', paid: true, priceEur: 15, whyOneSentence: 'Moorish castle with the best panoramic view over the river and city.' },
    { name: 'Sintra day trip', type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 14, whyOneSentence: 'Pena Palace + Quinta da Regaleira — leave by 08:00 to beat the tour buses.' },
    { name: 'Fado dinner in Bairro Alto', type: 'event', dateRange: 'all year', paid: true, priceEur: 55, whyOneSentence: 'A Tasca do Chico is the no-reservation standard; Mesa de Frades for upscale.' },
  ],
  amsterdam: [
    { name: 'Rijksmuseum + Vermeer', type: 'museum', dateRange: 'all year', paid: true, priceEur: 22, whyOneSentence: 'Book ahead — go 17:00 on Friday when locals are at the bar to dodge the crowd.' },
    { name: 'Vondelpark bike ride', type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 12, whyOneSentence: 'Rent a bike from MacBike, loop the park, end at Café Vondelpark for a beer.' },
    { name: 'Jordaan canal walk', type: 'neighborhood', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: 'Quieter, prettier canals than the Centrum — start at Westerkerk and meander north.' },
    { name: 'Anne Frank House', type: 'history', dateRange: 'all year', paid: true, priceEur: 16, whyOneSentence: 'Book months ahead — tickets release in 6-week tranches. Allow 90 min.' },
    { name: 'Indonesian rijsttafel', type: 'food', dateRange: 'all year', paid: true, priceEur: 40, whyOneSentence: 'Try Sampurna or Tempo Doeloe — 12-15 small dishes is the proper Dutch-colonial feast.' },
    { name: 'FOAM photography museum', type: 'museum', dateRange: 'all year', paid: true, priceEur: 14, whyOneSentence: 'Compact, rotating exhibitions — quieter alternative to the big-name museums.' },
  ],
  rome: [
    { name: 'Colosseum + Forum combo ticket', type: 'history', dateRange: 'all year', paid: true, priceEur: 24, whyOneSentence: 'Book the 08:30 entry; do the Forum first while the Colosseum line is still moving.' },
    { name: 'Vatican Museums + Sistine Chapel', type: 'museum', dateRange: 'all year', paid: true, priceEur: 25, whyOneSentence: 'Friday late-opening evenings are quieter; budget 3 hours minimum.' },
    { name: 'Trastevere dinner crawl', type: 'food', dateRange: 'all year', paid: true, priceEur: 40, whyOneSentence: 'Da Enzo for cacio e pepe, Suppli for the namesake fried rice balls, Pianostrada for inventive.' },
    { name: 'Borghese Gallery (Bernini sculptures)', type: 'museum', dateRange: 'all year', paid: true, priceEur: 22, whyOneSentence: 'Pre-booked timed slots only — see Bernini\'s Apollo and Daphne in person.' },
    { name: 'Aperitivo at Sant\'Eustachio', type: 'food', dateRange: 'all year', paid: true, priceEur: 8, whyOneSentence: 'Roman espresso reference standard; pair with a cornetto across from the Pantheon.' },
    { name: 'Appian Way Sunday cycling', type: 'outdoors', dateRange: 'Sundays', paid: true, priceEur: 12, whyOneSentence: 'The road closes to cars Sundays — rent a bike at Cecilia Metella and ride 12 km of antiquity.' },
  ],
  reykjavik: [
    { name: 'Golden Circle day tour', type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 80, whyOneSentence: 'Þingvellir + Geysir + Gullfoss — the canonical first-day loop.' },
    { name: 'Sky Lagoon (or Blue Lagoon)', type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 75, whyOneSentence: 'Sky Lagoon is newer + closer to town; Blue Lagoon is the famous one with the queue.' },
    { name: 'Hallgrímskirkja tower view', type: 'history', dateRange: 'all year', paid: true, priceEur: 7, whyOneSentence: 'Take the lift up the basalt-shaped church for the best city view.' },
    { name: 'Bæjarins Beztu hot dog', type: 'food', dateRange: 'all year', paid: true, priceEur: 5, whyOneSentence: 'A national institution. Order "eina með öllu" (one with everything).' },
    { name: 'Whale watching from Old Harbour', type: 'outdoors', dateRange: 'Apr-Oct', paid: true, priceEur: 90, whyOneSentence: 'Elding\'s 3-hour tour — minke + humpback peak season is June-August.' },
    { name: 'Northern Lights chase', type: 'event', dateRange: 'Sep-Mar', paid: true, priceEur: 65, whyOneSentence: 'Bus tour out of town when forecast > 3 — refunded re-try if you don\'t see them.' },
  ],
};

/** Generic evergreen template for destinations we haven't curated. */
function genericEvergreens(destination: string): Evergreen[] {
  const place = destination.split(',')[0].trim() || 'the city';
  return [
    { name: `Old town walking tour of ${place}`, type: 'neighborhood', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: `Free way to orient yourself — most cities run a tip-based "free walking tour" most mornings.` },
    { name: `Top-rated museum in ${place}`, type: 'museum', dateRange: 'all year', paid: true, priceEur: 15, whyOneSentence: `Every city has one canonical museum — check Google for the highest-rated one and book ahead.` },
    { name: `Food market in ${place}`, type: 'food', dateRange: 'all year', paid: true, priceEur: 20, whyOneSentence: `Central markets are the fastest path to local food — go for lunch, point at what looks good.` },
    { name: `Sunset viewpoint over ${place}`, type: 'outdoors', dateRange: 'all year', paid: false, priceEur: null, whyOneSentence: `Most cities have a hill, tower, or rooftop bar with the canonical sunset view — Google "${place} sunset spot".` },
    { name: `Day trip from ${place}`, type: 'outdoors', dateRange: 'all year', paid: true, priceEur: 30, whyOneSentence: `Most cities have a nearby town, beach, or castle worth a half-day train ride.` },
    { name: `Local-cuisine restaurant in ${place}`, type: 'food', dateRange: 'all year', paid: true, priceEur: 40, whyOneSentence: `Book one mid-range traditional place a week ahead so dinner is sorted on arrival day.` },
  ];
}

/** Match `destination` against the curated dictionary case-insensitively. */
function lookupEvergreens(destination: string): Evergreen[] {
  const needle = (destination || '').toLowerCase();
  for (const key of Object.keys(CURATED)) {
    if (needle.includes(key)) return CURATED[key];
  }
  return genericEvergreens(destination);
}

/** Build a small set of fabricated "this week" hints. Always confidence:medium. */
function fabricatedThisWeek(
  rng: () => number,
  destination: string,
  startDate: string
): Evergreen[] {
  const place = destination.split(',')[0].trim() || 'the area';
  const candidates: Evergreen[] = [
    { name: `Local farmers market this weekend`, type: 'food', dateRange: 'Saturday', paid: false, priceEur: null, whyOneSentence: `Most ${place}-style cities run a Saturday market — check the tourist board for the venue this week.` },
    { name: `Free outdoor cinema night`, type: 'event', dateRange: startDate, paid: false, priceEur: null, whyOneSentence: 'Summer often brings free pop-up screenings in central parks — check the city events page.' },
    { name: `Live music at a neighborhood bar`, type: 'concert', dateRange: 'most evenings', paid: true, priceEur: 10, whyOneSentence: 'Smaller venues post their lineup on Bandsintown or RA — searchable by date + city.' },
    { name: `Guided history walk`, type: 'history', dateRange: 'daily 10:00 + 17:00', paid: true, priceEur: 20, whyOneSentence: 'Most tourist offices run multi-language history walks twice daily — drop in same-day usually fine.' },
    { name: `Seasonal exhibition at the main gallery`, type: 'museum', dateRange: 'this month', paid: true, priceEur: 12, whyOneSentence: 'Check the main civic gallery for the rotating headline show — usually different from the permanent collection.' },
  ];
  // Pick 2-3 deterministically.
  const n = randInt(rng, 2, 3);
  const picks: Evergreen[] = [];
  const pool = [...candidates];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = randInt(rng, 0, pool.length - 1);
    picks.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picks;
}

/** Photo + booking link lookup — keyed by lowercase activity name fragment. */
const ACTIVITY_ENRICHMENT: Record<string, { imageUrl: string; bookingUrl?: string }> = {
  // Copenhagen
  'tivoli': {
    imageUrl: 'https://images.unsplash.com/photo-1533106418989-88406c7cc8ca?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.tivoli.dk/en/buy-tickets',
  },
  'nyhavn': {
    imageUrl: 'https://images.unsplash.com/photo-1513622470522-26c3c8a854bc?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.google.com/maps/search/Nyhavn+Copenhagen',
  },
  'louisiana': {
    imageUrl: 'https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.louisiana.dk/en/visit',
  },
  'christiania': {
    imageUrl: 'https://images.unsplash.com/photo-1527576539890-dfa815648363?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.google.com/maps/search/Christiania+Copenhagen',
  },
  'smørrebrød': {
    imageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&h=320&fit=crop',
    bookingUrl: 'https://aamanns.dk/en',
  },
  'rosenborg': {
    imageUrl: 'https://images.unsplash.com/photo-1533929736458-ca588d08c8be?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.kongernessamling.dk/en/rosenborg',
  },
  // Barcelona
  'sagrada': {
    imageUrl: 'https://images.unsplash.com/photo-1583422409516-2895a77efded?w=600&h=320&fit=crop',
    bookingUrl: 'https://sagradafamilia.org/en/tickets',
  },
  'park güell': {
    imageUrl: 'https://images.unsplash.com/photo-1539037116277-4db20889f2d4?w=600&h=320&fit=crop',
    bookingUrl: 'https://parkguell.barcelona/en/tickets',
  },
  'tapas': {
    imageUrl: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=600&h=320&fit=crop',
  },
  // Paris
  'louvre': {
    imageUrl: 'https://images.unsplash.com/photo-1565799557186-4a8acaa0a0c3?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.louvre.fr/en/visit/tickets',
  },
  'musée d\'orsay': {
    imageUrl: 'https://images.unsplash.com/photo-1572204292164-b35ba943fca7?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.musee-orsay.fr/en/visit',
  },
  // Berlin
  'east side gallery': {
    imageUrl: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.google.com/maps/search/East+Side+Gallery+Berlin',
  },
  'pergamon': {
    imageUrl: 'https://images.unsplash.com/photo-1561033819-09b8c3cd5e72?w=600&h=320&fit=crop',
    bookingUrl: 'https://www.smb.museum/en/museums-institutions/pergamonmuseum',
  },
  // Fallback by type
  'museum': {
    imageUrl: 'https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=600&h=320&fit=crop',
  },
  'food': {
    imageUrl: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=600&h=320&fit=crop',
  },
  'outdoors': {
    imageUrl: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=600&h=320&fit=crop',
  },
  'history': {
    imageUrl: 'https://images.unsplash.com/photo-1533929736458-ca588d08c8be?w=600&h=320&fit=crop',
  },
  'neighborhood': {
    imageUrl: 'https://images.unsplash.com/photo-1513622470522-26c3c8a854bc?w=600&h=320&fit=crop',
  },
  'concert': {
    imageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=600&h=320&fit=crop',
  },
};

/** Look up enrichment by activity name (substring match), fall back to type. */
function enrichmentFor(name: string, type: string): { imageUrl?: string; bookingUrl?: string } {
  const nameLower = name.toLowerCase();
  for (const [key, val] of Object.entries(ACTIVITY_ENRICHMENT)) {
    if (nameLower.includes(key)) return val;
  }
  // Fall back to type-based default image
  return ACTIVITY_ENRICHMENT[type] ?? {};
}

/** Promote an evergreen template into a finished ActivityItem (mock-sourced). */
function finalizeMock(e: Evergreen, defaultConfidence: ActivityItem['confidence']): ActivityItem {
  const enrichment = enrichmentFor(e.name, e.type);
  return {
    name: e.name,
    type: e.type,
    dateRange: e.dateRange,
    paid: e.paid,
    priceEur: e.priceEur ?? null,
    whyOneSentence: e.whyOneSentence,
    confidence: e.confidence ?? defaultConfidence,
    source: 'mock',
    imageUrl: enrichment.imageUrl,
    bookingUrl: enrichment.bookingUrl,
  };
}

export class MockActivityProvider implements ActivityProvider {
  readonly name = 'mock';
  readonly isReal = false;

  async fetchActivities(input: ActivitySearchInput): Promise<ActivitySearchResult> {
    const destination = (input.destination ?? '').trim();
    const startDate = input.startDate ?? '';
    const endDate = input.endDate ?? '';

    if (!destination) {
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'destination_too_obscure',
      };
    }

    const seed = hash32(`${destination}|${startDate}|${endDate}`);
    const rng = mulberry32(seed);

    const evergreens = lookupEvergreens(destination);
    const thisWeekRaw = fabricatedThisWeek(rng, destination, startDate);

    const alwaysGreat: ActivityItem[] = evergreens.map((e) =>
      finalizeMock(e, 'high')
    );
    // "this week" items are fabricated → always medium confidence.
    const thisWeek: ActivityItem[] = thisWeekRaw.map((e) =>
      finalizeMock(e, 'medium')
    );

    return {
      activities: { thisWeek, alwaysGreat },
      reason: 'ok',
    };
  }
}
