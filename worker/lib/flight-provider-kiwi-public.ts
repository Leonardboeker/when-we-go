// worker/lib/flight-provider-kiwi-public.ts
// REAL, keyless flight provider backed by Kiwi.com's public Skypicker GraphQL
// endpoint (the same backend kiwi.com itself uses).
//
//   POST https://api.skypicker.com/umbrella/v2/graphql
//   - No auth header. Just Content-Type: application/json.
//   - partner / affilID = "skypicker" identify us as the (public) partner.
//   - Accepts arbitrary (non-persisted) GraphQL queries → we send trimmed ones.
//
// Two queries are used (request/variable shape ported from the rflights R
// package, github.com/jcrodriguez1989/rflights, which hits the same endpoint):
//   1. UmbrellaPlacesQuery        — resolve an IATA/term to a Kiwi place id
//                                    (we prefer Station:airport:<IATA>).
//   2. SearchReturnItinerariesQuery / SearchOneWayItinerariesQuery — the actual
//      search. Booking deep-link lives at
//      itinerary.bookingOptions.edges[].node.bookingUrl; total price at
//      itinerary.priceEur.amount; carrier on the first segment.
//
// Everything returned here is real: real EUR prices, real airlines, real
// bookingUrl deep-links straight to kiwi.com's checkout. No fabricated data.
//
// Failure policy: on ANY failure (network, HTTP != 200, GraphQL error, empty)
// we resolve to a graceful reason instead of returning junk. Hard faults throw
// so flights.ts's searchFlights() wrapper downgrades to 'provider_error'.

import type {
  FlightOption,
  FlightProvider,
  FlightSearchInput,
  FlightSearchResult,
} from './flight-provider.ts';

// ─── endpoint + tuning ───────────────────────────────────────────────────────

const ENDPOINT = 'https://api.skypicker.com/umbrella/v2/graphql';
const KIWI_WEB = 'https://www.kiwi.com';
const REQUEST_TIMEOUT_MS = 8000;
/** How many parsed itineraries we keep (cheapest-first). */
const MAX_RESULTS = 6;
/** Upper bound on stops we ask the API for (keeps results sane). */
const MAX_STOPS = 2;
/** Per-search soft cap on itineraries fetched before client-side trim. */
const API_LIMIT = 50;

// ─── trimmed GraphQL documents ───────────────────────────────────────────────
// Only the fields we actually consume, to keep the payload small.

const PLACES_QUERY =
  'query UmbrellaPlacesQuery($search:PlacesSearchInput,$filter:PlacesFilterInput,$options:PlacesOptionsInput,$first:Int!){' +
  'places(search:$search,filter:$filter,options:$options,first:$first){__typename ' +
  '... on AppError{error:message} ' +
  '... on PlaceConnection{edges{node{__typename id legacyId name ' +
  '... on City{code} ... on Station{code type}}}}}}';

const RETURN_QUERY =
  'query SearchReturnItinerariesQuery($search:SearchReturnInput,$filter:ItinerariesFilterInput,$options:ItinerariesOptionsInput){' +
  'returnItineraries(search:$search,filter:$filter,options:$options){__typename ' +
  '... on AppError{error:message} ' +
  '... on Itineraries{itineraries{__typename ... on ItineraryReturn{' +
  'id priceEur{amount} ' +
  'bookingOptions{edges{node{bookingUrl price{amount} priceEur{amount}}}} ' +
  'outbound{duration sectorSegments{segment{source{localTime station{code}} destination{localTime station{code}} carrier{code name}}}} ' +
  'inbound{duration sectorSegments{segment{source{localTime station{code}} destination{localTime station{code}} carrier{code name}}}}' +
  '}}}}}';

const ONEWAY_QUERY =
  'query SearchOneWayItinerariesQuery($search:SearchOnewayInput,$filter:ItinerariesFilterInput,$options:ItinerariesOptionsInput){' +
  'onewayItineraries(search:$search,filter:$filter,options:$options){__typename ' +
  '... on AppError{error:message} ' +
  '... on Itineraries{itineraries{__typename ... on ItineraryOneWay{' +
  'id priceEur{amount} ' +
  'bookingOptions{edges{node{bookingUrl price{amount} priceEur{amount}}}} ' +
  'sector{duration sectorSegments{segment{source{localTime station{code}} destination{localTime station{code}} carrier{code name}}}}' +
  '}}}}}';

// ─── response shapes (only the bits we read) ─────────────────────────────────

interface PriceAmount {
  amount?: string | number | null;
}
interface Carrier {
  code?: string | null;
  name?: string | null;
}
interface Segment {
  source?: { localTime?: string | null; station?: { code?: string | null } | null } | null;
  destination?: { localTime?: string | null; station?: { code?: string | null } | null } | null;
  carrier?: Carrier | null;
}
interface SectorSegment {
  segment?: Segment | null;
}
interface Sector {
  duration?: number | null;
  sectorSegments?: SectorSegment[] | null;
}
interface BookingNode {
  bookingUrl?: string | null;
  price?: PriceAmount | null;
  priceEur?: PriceAmount | null;
}
interface ItineraryBase {
  __typename?: string;
  id?: string;
  priceEur?: PriceAmount | null;
  bookingOptions?: { edges?: Array<{ node?: BookingNode | null } | null> | null } | null;
}
interface ItineraryOneWay extends ItineraryBase {
  sector?: Sector | null;
}
interface ItineraryReturn extends ItineraryBase {
  outbound?: Sector | null;
  inbound?: Sector | null;
}

interface PlacesEdge {
  node?: {
    __typename?: string;
    id?: string;
    code?: string | null;
    type?: string | null;
  } | null;
}
interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Full-day window in the local-naive ISO format the API expects. */
function dayWindow(iso: string): { start: string; end: string } {
  return { start: `${iso}T00:00:00`, end: `${iso}T23:59:59` };
}

/** Coerce the string|number priceEur.amount to a finite number (0 on junk). */
function toAmount(p: PriceAmount | null | undefined): number {
  if (!p || p.amount == null) return 0;
  const n = typeof p.amount === 'number' ? p.amount : Number(p.amount);
  return Number.isFinite(n) ? n : 0;
}

/** Ensure an absolute booking URL (API already returns absolute, but be safe). */
function absoluteBookingUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith('/') ? `${KIWI_WEB}${url}` : `${KIWI_WEB}/${url}`;
}

function durationHint(stops: number, durationMinTotal: number): string {
  const stopsLabel = stops === 0 ? 'Direkt' : `${stops} Stopp${stops > 1 ? 's' : ''}`;
  const h = Math.floor(durationMinTotal / 60);
  const m = durationMinTotal % 60;
  return `${stopsLabel} · ${h}h ${m}m`;
}

/** Static variable blocks shared by one-way + return searches. */
const PASSENGERS = {
  adults: 1,
  children: 0,
  infants: 0,
  adultsHoldBags: 0,
  adultsHandBags: 0,
  childrenHoldBags: [] as unknown[],
  childrenHandBags: [] as unknown[],
};
const CABIN_CLASS = { cabinClass: 'ECONOMY', applyMixedClasses: false };

function searchFilter() {
  return {
    allowChangeInboundDestination: true,
    allowChangeInboundSource: true,
    allowDifferentStationConnection: true,
    enableSelfTransfer: true,
    enableThrowAwayTicketing: true,
    enableTrueHiddenCity: true,
    transportTypes: ['FLIGHT'],
    contentProviders: ['KIWI', 'FRESH', 'KAYAK'],
    flightsApiLimit: API_LIMIT,
    limit: API_LIMIT,
    maxStopsCount: MAX_STOPS,
  };
}

function searchOptions(currency: string) {
  return {
    sortBy: 'PRICE',
    mergePriceDiffRule: 'INCREASED',
    currency: currency.toLowerCase(),
    apiUrl: null,
    locale: 'en',
    partner: 'skypicker',
    affilID: 'skypicker',
    storeSearch: false,
    searchStrategy: 'REDUCED',
    serverToken: null,
  };
}

// ─── provider ────────────────────────────────────────────────────────────────

export class KiwiPublicFlightProvider implements FlightProvider {
  readonly name = 'kiwi-public';
  readonly isReal = true;

  /** Per-call memo so we resolve each IATA at most once. */
  private placeCache = new Map<string, string | null>();

  async searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
    const originIata = (input.originIata ?? '').toUpperCase().trim();
    const destinationIata = (input.destinationIata ?? '').toUpperCase().trim();
    const currency = (input.currency ?? 'EUR').toUpperCase();

    if (!originIata) return { reason: 'profile_incomplete', flights: [] };
    if (!destinationIata) return { reason: 'destination_unmapped', flights: [] };

    // 1. Resolve both endpoints to Kiwi place ids (parallel).
    let fromId: string | null;
    let toId: string | null;
    try {
      [fromId, toId] = await Promise.all([
        this.resolvePlaceId(originIata),
        this.resolvePlaceId(destinationIata),
      ]);
    } catch (err) {
      console.error('[kiwi-public] place resolution failed', err);
      // Hard throw → flights.ts maps to provider_error.
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (!fromId) return { reason: 'destination_unmapped', flights: [] };
    if (!toId) return { reason: 'destination_unmapped', flights: [] };

    // 2. Build + run the itinerary search (return vs one-way).
    const isReturn = Boolean(input.returnDate);
    const itinerary: Record<string, unknown> = {
      source: { ids: [fromId] },
      destination: { ids: [toId] },
      outboundDepartureDate: dayWindow(input.departDate),
    };
    if (isReturn && input.returnDate) {
      itinerary.inboundDepartureDate = dayWindow(input.returnDate);
    }

    const variables = {
      search: { itinerary, passengers: PASSENGERS, cabinClass: CABIN_CLASS },
      filter: searchFilter(),
      options: searchOptions(currency),
    };

    const featureName = isReturn
      ? 'SearchReturnItinerariesQuery'
      : 'SearchOneWayItinerariesQuery';
    const query = isReturn ? RETURN_QUERY : ONEWAY_QUERY;

    const json = await this.post<Record<string, unknown>>(featureName, query, variables);

    const flights = isReturn
      ? this.parseReturn(json as GqlResponse<{ returnItineraries?: { itineraries?: ItineraryReturn[] } }>)
      : this.parseOneWay(json as GqlResponse<{ onewayItineraries?: { itineraries?: ItineraryOneWay[] } }>);

    if (flights.length === 0) return { reason: 'no_routes', flights: [] };

    flights.sort((a, b) => a.priceEur - b.priceEur);
    return { reason: 'ok', flights: flights.slice(0, MAX_RESULTS) };
  }

  // ── place resolution ─────────────────────────────────────────────────────

  /**
   * Resolve an IATA to a Kiwi place id, preferring the airport station
   * (`Station:airport:<IATA>`), then a matching city, then the first result.
   * Returns null when nothing matches (caller surfaces destination_unmapped).
   */
  private async resolvePlaceId(iata: string): Promise<string | null> {
    if (this.placeCache.has(iata)) return this.placeCache.get(iata) ?? null;

    const json = await this.post<{ places?: { edges?: PlacesEdge[] } }>(
      'UmbrellaPlacesQuery',
      PLACES_QUERY,
      {
        search: { term: iata },
        filter: { onlyTypes: ['AIRPORT', 'CITY'] },
        options: { locale: 'en' },
        first: 5,
      }
    );

    const edges = json.data?.places?.edges ?? [];

    // Prefer the exact airport station for this IATA.
    const station = edges.find(
      (e) => e.node?.__typename === 'Station' && e.node?.code === iata
    );
    let id: string | null = station?.node?.id ?? null;
    if (!id) {
      const city = edges.find((e) => e.node?.__typename === 'City');
      id = city?.node?.id ?? edges[0]?.node?.id ?? null;
    }

    this.placeCache.set(iata, id);
    return id;
  }

  // ── transport ─────────────────────────────────────────────────────────────

  /** POST a GraphQL op, throwing on transport/HTTP/GraphQL failure. */
  private async post<T>(
    featureName: string,
    query: string,
    variables: unknown
  ): Promise<GqlResponse<T>> {
    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}?featureName=${featureName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `[kiwi-public] ${featureName} network/timeout: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[kiwi-public] ${featureName} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    let json: GqlResponse<T>;
    try {
      json = (await res.json()) as GqlResponse<T>;
    } catch (err) {
      throw new Error(
        `[kiwi-public] ${featureName} JSON parse: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `[kiwi-public] ${featureName} GraphQL errors: ${json.errors
          .map((e) => e.message ?? '?')
          .join('; ')
          .slice(0, 300)}`
      );
    }

    return json;
  }

  // ── parsing ─────────────────────────────────────────────────────────────

  private parseReturn(
    json: GqlResponse<{ returnItineraries?: { itineraries?: ItineraryReturn[] } }>
  ): FlightOption[] {
    const its = json.data?.returnItineraries?.itineraries ?? [];
    const out: FlightOption[] = [];
    for (const it of its) {
      const opt = this.itineraryToOption(
        it,
        it.outbound ?? null,
        // Total round-trip duration = outbound + inbound flying time.
        (it.outbound?.duration ?? 0) + (it.inbound?.duration ?? 0)
      );
      if (opt) out.push(opt);
    }
    return out;
  }

  private parseOneWay(
    json: GqlResponse<{ onewayItineraries?: { itineraries?: ItineraryOneWay[] } }>
  ): FlightOption[] {
    const its = json.data?.onewayItineraries?.itineraries ?? [];
    const out: FlightOption[] = [];
    for (const it of its) {
      const opt = this.itineraryToOption(it, it.sector ?? null, it.sector?.duration ?? 0);
      if (opt) out.push(opt);
    }
    return out;
  }

  /**
   * Map one itinerary + its outbound sector to a FlightOption. `durationSec` is
   * the total trip flying time (round-trip sums both legs). Returns null when
   * the itinerary has no usable price.
   */
  private itineraryToOption(
    it: ItineraryBase,
    outboundSector: Sector | null,
    durationSec: number
  ): FlightOption | null {
    const node = it.bookingOptions?.edges?.[0]?.node ?? null;

    // Price: prefer itinerary-level priceEur, fall back to booking-option's.
    const priceEur = Math.round(toAmount(it.priceEur) || toAmount(node?.priceEur));
    if (priceEur <= 0) return null;

    const segs = outboundSector?.sectorSegments ?? [];
    const firstSeg = segs[0]?.segment ?? null;
    const lastSeg = segs[segs.length - 1]?.segment ?? null;
    const carrier = firstSeg?.carrier ?? {};

    const stops = Math.max(0, segs.length - 1);
    const durationMinTotal = Math.round(durationSec / 60);
    const carrierCode = (carrier.code ?? 'XX').toUpperCase();
    const airline = carrier.name ?? carrierCode;

    return {
      airline,
      carrierCode,
      durationMinTotal,
      stops,
      priceEur,
      priceCurrency: 'EUR',
      departureTimeLocal: firstSeg?.source?.localTime ?? '',
      arrivalTimeLocal: lastSeg?.destination?.localTime ?? '',
      bookingHint: durationHint(stops, durationMinTotal),
      source: 'kiwi',
      bookingUrl: absoluteBookingUrl(node?.bookingUrl),
    };
  }
}
