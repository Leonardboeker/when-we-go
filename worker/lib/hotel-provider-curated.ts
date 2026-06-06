// worker/lib/hotel-provider-curated.ts
// Real, hand-curated hotels for known destinations. Replaces the fabricated
// mock so the in-app data is genuine: real hotel names, real neighbourhoods,
// real Booking.com deep links (pre-filled with the trip dates + guests) and a
// representative photo. NO in-app prices are invented — `priceUnknown: true`
// makes the UI show "Preis live ansehen" and the Booking link shows the real
// live price. `isReal = true` → no DEMO banner.
//
// Unknown destinations fall back to an empty list with reason 'no_inventory';
// the handler/UI then offers a Booking.com city-search deep link.

import type {
  HotelOption,
  HotelProvider,
  HotelSearchInput,
  HotelSearchResult,
} from './hotel-provider.ts';

interface CuratedHotel {
  name: string;
  stars: number;
  /** Approx. distance to city centre in km (real, rounded). */
  distanceKm: number;
  /** Short real-neighbourhood / vibe descriptor (German). */
  area: string;
  amenities: string[];
  /** Representative Unsplash photo (category-appropriate). */
  imageUrl: string;
  /** Real latitude (WGS84) of the hotel — drives the Leaflet map marker. */
  lat: number;
  /** Real longitude (WGS84) of the hotel — see `lat`. */
  lng: number;
}

// Keyed by lowercase city substring (matches destinationCity / poll.destination).
const CURATED: Record<string, CuratedHotel[]> = {
  copenhagen: [
    {
      name: 'Villa Copenhagen',
      stars: 5,
      distanceKm: 0.4,
      area: 'Vesterbro, am Hauptbahnhof',
      amenities: ['Spa', 'Rooftop-Pool', 'Restaurant', 'WLAN'],
      imageUrl: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&h=340&fit=crop',
      // Tietgensgade 35-39, next to København H.
      lat: 55.6705,
      lng: 12.5636,
    },
    {
      name: 'Nimb Hotel',
      stars: 5,
      distanceKm: 0.6,
      area: 'Im Tivoli-Garten',
      amenities: ['Rooftop-Terrasse', 'Fine Dining', 'Bar', 'WLAN'],
      imageUrl: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=600&h=340&fit=crop',
      // Bernstorffsgade 5, inside Tivoli Gardens.
      lat: 55.6738,
      lng: 12.5681,
    },
    {
      name: 'Hotel SP34 (Brøchner)',
      stars: 4,
      distanceKm: 0.9,
      area: 'Latinerkvarteret (Altstadt)',
      amenities: ['Weinstunde', 'Bar', 'Fahrradverleih', 'WLAN'],
      imageUrl: 'https://images.unsplash.com/photo-1455587734955-081b22074882?w=600&h=340&fit=crop',
      // Sankt Peders Straede 34, Latin Quarter.
      lat: 55.6796,
      lng: 12.5688,
    },
    {
      name: 'Axel Guldsmeden',
      stars: 4,
      distanceKm: 1.1,
      area: 'Vesterbro (Bio/Eco)',
      amenities: ['Bio-Frühstück', 'Spa', 'Eco-zertifiziert', 'WLAN'],
      imageUrl: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&h=340&fit=crop',
      // Helgolandsgade 11, Vesterbro.
      lat: 55.6723,
      lng: 12.5575,
    },
    {
      name: 'Coco Hotel',
      stars: 4,
      distanceKm: 1.0,
      area: 'Vesterbro',
      amenities: ['Innenhof', 'Bar', 'Design', 'WLAN'],
      imageUrl: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=600&h=340&fit=crop',
      // Vesterbrogade 41, Vesterbro.
      lat: 55.6716,
      lng: 12.5544,
    },
    {
      name: 'Generator Copenhagen',
      stars: 2,
      distanceKm: 0.8,
      area: 'City / Nørreport (Budget/Hostel)',
      amenities: ['Bar', 'Lounge', 'Günstig', 'WLAN'],
      imageUrl: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=340&fit=crop',
      // Adelgade 5-7, near Kongens Nytorv / Norreport.
      lat: 55.6817,
      lng: 12.5826,
    },
  ],
};

function lookupCity(input: HotelSearchInput): CuratedHotel[] | null {
  const hay = (input.destinationCity || '').toLowerCase();
  for (const key of Object.keys(CURATED)) {
    if (hay.includes(key)) return CURATED[key];
  }
  return null;
}

function bookingUrl(name: string, city: string, input: HotelSearchInput): string {
  const params = new URLSearchParams({
    ss: name + ' ' + city,
    group_adults: String(Math.max(1, input.guests || 1)),
    no_rooms: '1',
  });
  if (input.checkInDate) params.set('checkin', input.checkInDate);
  if (input.checkOutDate) params.set('checkout', input.checkOutDate);
  return 'https://www.booking.com/searchresults.html?' + params.toString();
}

export class CuratedHotelProvider implements HotelProvider {
  readonly name = 'curated';
  readonly isReal = true;

  async searchHotels(input: HotelSearchInput): Promise<HotelSearchResult> {
    const list = lookupCity(input);
    if (!list) {
      // No curated set for this city — caller offers a Booking search link.
      return { hotels: [], reason: 'no_inventory' };
    }
    const city = input.destinationCity || 'Copenhagen';
    const hotels: HotelOption[] = list.map((h, i) => ({
      hotelId: 'curated-' + city.toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + i,
      name: h.name,
      stars: h.stars,
      distanceToCenterKm: h.distanceKm,
      imageUrl: h.imageUrl,
      bookingUrl: bookingUrl(h.name, city, input),
      priceUnknown: true,
      // Real coords drive the Leaflet map marker; undefined for future
      // non-geocoded curated cities (the map skips markers without coords).
      lat: h.lat,
      lng: h.lng,
      // No invented prices — these stay 0 and the UI shows "Preis live ansehen".
      totalPriceEur: 0,
      nightlyPriceEur: 0,
      perPersonEur: 0,
      amenities: h.amenities,
      bookingHint: h.area,
      source: 'curated',
    }));
    return { hotels, reason: 'ok' };
  }
}
