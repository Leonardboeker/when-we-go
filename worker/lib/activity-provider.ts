// worker/lib/activity-provider.ts
// Phase 7 (PROVIDER-ABSTRACTED) — pluggable activity-suggestion interface +
// `getActivityProvider(env)` factory. Mirrors flight-provider.ts /
// hotel-provider.ts so the cron + email + UI pipelines see a stable shape
// regardless of which backend is wired.
//
// Two impls today:
//   - ClaudeActivityProvider — real, requires WHENWEGO_ANTHROPIC_API_KEY.
//     Uses Anthropic's structured-output `tools` API to force JSON conformant
//     to ActivityList (no prose parsing needed).
//   - MockActivityProvider — deterministic fallback. Hand-curated evergreens
//     for top destinations + generic templates for the long tail.
//
// `source` on each ActivityItem is the provider attribution string — the UI
// reads it to render a "DEMO data" banner when source === 'mock'.

import type { Env } from '../durable-object';

export type ActivityReason =
  | 'ok'
  | 'destination_too_obscure'
  | 'not_configured'
  | 'provider_error';

export type ActivityType =
  | 'concert'
  | 'festival'
  | 'museum'
  | 'food'
  | 'outdoors'
  | 'history'
  | 'neighborhood'
  | 'event'
  | 'other';

export type ActivityConfidence = 'high' | 'medium' | 'low';

export type ActivitySource = 'mock' | 'claude' | 'wikimedia';

export interface ActivityItem {
  /** Display name, max 80 chars per schema. */
  name: string;
  /** Coarse category — UI maps to an icon. */
  type: ActivityType;
  /** Free-form date hint, e.g. "all summer", "Jul 12-13", "Tuesdays only". */
  dateRange: string;
  /** True if the activity costs money. */
  paid: boolean;
  /** Approximate EUR price; null/undefined when unknown or free. */
  priceEur?: number | null;
  /** Single-sentence "why" pitch — max 160 chars per schema. */
  whyOneSentence: string;
  /** Honest uncertainty marker; UI shows badges on medium/low. */
  confidence: ActivityConfidence;
  /** Provider attribution — UI gates DEMO banner on `source === 'mock'`. */
  source: ActivitySource;
  /** Photo URL for the activity thumbnail (optional). Mock: Unsplash; real:
   *  Wikimedia pageimages thumbnail (or Openverse CC fallback). */
  imageUrl?: string;
  /** Canonical "ansehen" link — Wikipedia article / official page (optional). */
  link?: string;
  /** Google Maps link built from coordinates (optional). */
  mapsUrl?: string;
  /** Latitude (WGS84) — carried through for a future Leaflet map (optional). */
  lat?: number;
  /** Longitude (WGS84) — carried through for a future Leaflet map (optional). */
  lng?: number;
  /** Photo attribution line, e.g. "CC BY-SA · Flickr/<author>" (optional).
   *  Set for Openverse-sourced fallback photos to honour the licence. */
  photoAttribution?: string;
  /** Booking / maps / venue link (optional). */
  bookingUrl?: string;
}

export interface ActivityList {
  /** Time-bound suggestions for the specific date window. Max ~4. */
  thisWeek: ActivityItem[];
  /** Evergreen highlights (museums, neighborhoods, food). Max ~6. */
  alwaysGreat: ActivityItem[];
}

export interface ActivitySearchInput {
  /** Free-text destination — provider implementations interpret as needed. */
  destination: string;
  /** ISO YYYY-MM-DD, inclusive. */
  startDate: string;
  /** ISO YYYY-MM-DD, inclusive. */
  endDate: string;
  /** Group size — only used by the prompt for context. */
  participantCount: number;
}

export interface ActivitySearchResult {
  activities: ActivityList;
  reason: ActivityReason;
}

export interface ActivityProvider {
  /** Human/log identifier — appears in cache keys + logs. */
  readonly name: string;
  /** Mock impls return false so callers can render a clear DEMO banner. */
  readonly isReal: boolean;
  fetchActivities(input: ActivitySearchInput): Promise<ActivitySearchResult>;
}

/**
 * Single source of truth for "which activity provider is wired". Priority:
 *   1. ClaudeActivityProvider — explicit opt-in when WHENWEGO_ANTHROPIC_API_KEY
 *      is set (curated prose + uncertainty handling).
 *   2. WikimediaActivityProvider — the DEFAULT real, keyless provider. Real
 *      POIs with real photos + Wikipedia/Maps links + coords, no secret needed.
 *      Mirrors the keyless KiwiPublicFlightProvider default on the flights side.
 *   3. MockActivityProvider — last-resort deterministic fallback (only reached
 *      if the others are explicitly swapped out; kept so tests + the DEMO
 *      banner path still have a stable impl).
 *
 * The Wikimedia provider throws on hard failure so the activities.ts wrapper
 * downgrades to reason:'provider_error' (handler then serves stale cache).
 */
import { MockActivityProvider } from './activity-provider-mock.ts';
import { ClaudeActivityProvider } from './activity-provider-claude.ts';
import { WikimediaActivityProvider } from './activity-provider-wikimedia.ts';

export function getActivityProvider(env: Env): ActivityProvider {
  // 1. Claude path wins when its key is configured (explicit opt-in).
  if (env.WHENWEGO_ANTHROPIC_API_KEY) {
    return new ClaudeActivityProvider(env.WHENWEGO_ANTHROPIC_API_KEY);
  }
  // 2. Default REAL provider — keyless Wikipedia geosearch + pageviews.
  //    Optional OpenTripMap enrichment when WHENWEGO_OPENTRIPMAP_API_KEY exists,
  //    but the Wikipedia-only path needs no secret and is what ships by default.
  return new WikimediaActivityProvider({
    openTripMapApiKey: env.WHENWEGO_OPENTRIPMAP_API_KEY,
  });
}
