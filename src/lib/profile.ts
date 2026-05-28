// src/lib/profile.ts
// Client-side type definitions for the participant profile.
// Mirrors the shape exposed by /api/poll's `viewer.profile` field and accepted
// by POST /api/profile. The Worker-side `ParticipantProfile` interface in
// worker/durable-object.ts is intentionally identical — we keep them as separate
// declarations because the worker bundle can't import from src/.

export type ProfileInterest =
  | 'museums'
  | 'outdoors'
  | 'food'
  | 'nightlife'
  | 'history'
  | 'festivals'
  | 'shopping'
  | 'beach';

export const PROFILE_INTERESTS: ProfileInterest[] = [
  'museums',
  'outdoors',
  'food',
  'nightlife',
  'history',
  'festivals',
  'shopping',
  'beach',
];

export interface ParticipantProfile {
  /** Where to send trip details. Optional in the schema but required for the
   *  profile to count as "complete" (downstream phases need it). */
  email?: string;
  /** IATA 3-letter code, uppercase. e.g. "MUC". */
  homeAirport?: string;
  /** Human-readable city display, e.g. "Munich". Derived from airport lookup. */
  homeCity?: string;
  /** Per-person budget cap in EUR. Three preset tiers (200/500/1000) or unset. */
  budgetMaxEur?: number;
  /** Up to 8 interest tags for downstream relevance filtering. */
  interests?: ProfileInterest[];
}

/** A profile is "complete" when email + homeAirport are set. */
export function isProfileComplete(
  profile: ParticipantProfile | null | undefined
): boolean {
  if (!profile) return false;
  return Boolean(profile.email && profile.homeAirport);
}
