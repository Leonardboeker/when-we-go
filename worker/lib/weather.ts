// worker/lib/weather.ts
// Open-Meteo 7-day forecast for the T-7 reminder email. The free public API
// requires no auth and (per Open-Meteo's free-tier rules) tolerates ~10k
// calls/day — well above what one cron tick will ever hit.
//
// Cache: 6h, keyed by `weather:<lat>:<lon>:<days>` in the DO's proposal_cache
// table. We pass a DO stub through because the caller (reminder fan-out)
// already has one open; opening a fresh stub here just for cache would be
// wasteful and would force a network round-trip per fan-out.
//
// Fail-soft: every error path returns null. The T-7 email template renders
// a graceful "couldn't fetch weather" line in that case (CONTEXT D-11).
import destinationsGeo from '../../src/data/destinations-geo.json' with { type: 'json' };

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

export interface ForecastDay {
  date: string;            // YYYY-MM-DD
  tempMaxC: number | null;
  tempMinC: number | null;
  weatherCode: number | null;     // WMO code; map to icon/label in template
  precipProbPct: number | null;   // 0..100
}

export interface Forecast {
  daily: ForecastDay[];
  destination: string;            // resolved match for debug
  lat: number;
  lon: number;
}

interface OpenMeteoResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
    precipitation_probability_max?: number[];
  };
}

interface DestGeoRow {
  name: string;
  lat: number;
  lon: number;
}

interface DestinationsGeoFile {
  cities: DestGeoRow[];
}

const GEO = (destinationsGeo as unknown as DestinationsGeoFile).cities;

/**
 * Resolve a free-form destination string ("Copenhagen, Denmark") to a known
 * lat/lon row. Substring-match (case-insensitive) against the city name. Null
 * when the table doesn't carry the destination — caller skips weather then.
 */
export function resolveDestinationGeo(
  destination: string
): { name: string; lat: number; lon: number } | null {
  if (!destination) return null;
  const haystack = destination.toLowerCase();
  for (const row of GEO) {
    if (haystack.includes(row.name.toLowerCase())) {
      return { name: row.name, lat: row.lat, lon: row.lon };
    }
  }
  return null;
}

/**
 * Cache-aware getter for a forecast. Pass an object with `getCached` /
 * `setCached` (typically the DO stub). The cache key embeds lat/lon+days
 * so concurrent polls for the same destination share data automatically.
 *
 * Returns null on:
 *   - network timeout / 5xx
 *   - JSON parse failure
 *   - missing daily.time array
 */
export interface WeatherCache {
  getCached(key: string): Promise<string | null> | string | null;
  setCached(key: string, value: string, ttlMs: number): Promise<void> | void;
}

export async function getForecast(
  cache: WeatherCache,
  destination: string,
  days = 7
): Promise<Forecast | null> {
  const geo = resolveDestinationGeo(destination);
  if (!geo) {
    console.log(`[weather] no geo row for "${destination}" — skip`);
    return null;
  }

  const cacheKey = `weather:${geo.lat}:${geo.lon}:${days}`;
  const cached = await cache.getCached(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Forecast;
      return parsed;
    } catch {
      // fall through to live fetch on corrupt cache
    }
  }

  const url =
    `${OPEN_METEO_BASE}?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max` +
    `&forecast_days=${days}&timezone=auto`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.log(`[weather] HTTP ${res.status} for ${destination}`);
      return null;
    }
    const body = (await res.json()) as OpenMeteoResponse;
    const times = body.daily?.time ?? [];
    if (times.length === 0) {
      console.log(`[weather] empty daily.time from Open-Meteo for ${destination}`);
      return null;
    }
    const forecast: Forecast = {
      destination: geo.name,
      lat: geo.lat,
      lon: geo.lon,
      daily: times.map((date, i) => ({
        date,
        tempMaxC: body.daily?.temperature_2m_max?.[i] ?? null,
        tempMinC: body.daily?.temperature_2m_min?.[i] ?? null,
        weatherCode: body.daily?.weather_code?.[i] ?? null,
        precipProbPct: body.daily?.precipitation_probability_max?.[i] ?? null,
      })),
    };
    await cache.setCached(cacheKey, JSON.stringify(forecast), CACHE_TTL_MS);
    return forecast;
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[weather] fetch failed for ${destination}: ${msg}`);
    return null;
  }
}

/**
 * Tiny mapping of WMO weather codes → one-line human label. Covers the
 * common cases; falls back to "—" so the email never blank-renders a number.
 * Source: https://open-meteo.com/en/docs (WMO Weather interpretation codes).
 */
export function weatherCodeLabel(code: number | null): string {
  if (code === null) return '—';
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 49) return 'Foggy';
  if (code <= 59) return 'Drizzle';
  if (code <= 69) return 'Rain';
  if (code <= 79) return 'Snow';
  if (code <= 84) return 'Showers';
  if (code <= 99) return 'Thunderstorm';
  return '—';
}
