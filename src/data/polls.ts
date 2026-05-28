// src/data/polls.ts
// Materialised at build time by scripts/prebuild-polls.mjs from either
// data/polls.json (local dev) or the WHENWEGO_POLLS_JSON env var (CI).
import raw from '../../data/polls.json';

export type Participant = {
  /** nanoid(16) — unique per participant per poll. Used in /<slug>/<token>/ URL. */
  token: string;
  /** Display name (first name typical). Appears in greeting + admin list. */
  name: string;
};

export type Poll = {
  /** URL-safe poll identifier (e.g. "copenhagen-2026").
   *  Reserved values forbidden: admin, api, 404, favicon, robots, sitemap, og. */
  slug: string;
  /** Human-readable title, e.g. "Copenhagen — family of 4". */
  title: string;
  /** Optional destination string (city, country). Shown in greeting. */
  destination?: string;
  /** ISO date, inclusive. e.g. "2026-06-01". */
  dateRangeStart: string;
  /** ISO date, inclusive. e.g. "2026-09-30". */
  dateRangeEnd: string;
  /** ISO timestamp with TZ. e.g. "2026-06-14T23:59:59+02:00".
   *  After this moment, the per-token page renders read-only. (Phase 2.) */
  pollCloseAt: string;
  /** nanoid(22) — organiser-only token. Reaches the admin dashboard. */
  organizerToken: string;
  /** Participant list. */
  participants: Participant[];
  /** ISO timestamp the poll was generated. */
  createdAt: string;
};

export const polls: Poll[] = raw as Poll[];
