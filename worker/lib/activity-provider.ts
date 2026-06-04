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

export type ActivitySource = 'mock' | 'claude';

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
  /** Unsplash photo URL for the activity thumbnail (optional). */
  imageUrl?: string;
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
 * Single source of truth for "which activity provider is wired".
 * Real Claude path when WHENWEGO_ANTHROPIC_API_KEY is set; mock otherwise.
 * Mock is the safe fallback so the whole pipeline (cron + email + UI) keeps
 * working when the secret is missing or the API is down.
 */
import { MockActivityProvider } from './activity-provider-mock.ts';
import { ClaudeActivityProvider } from './activity-provider-claude.ts';

export function getActivityProvider(env: Env): ActivityProvider {
  if (env.WHENWEGO_ANTHROPIC_API_KEY) {
    return new ClaudeActivityProvider(env.WHENWEGO_ANTHROPIC_API_KEY);
  }
  return new MockActivityProvider();
}
