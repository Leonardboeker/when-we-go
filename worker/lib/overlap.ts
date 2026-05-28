// worker/lib/overlap.ts
// Pure overlap calculation. Input: poll config + vote rows; output: per-date
// breakdown + tier sets + merged ranges.
//
// Tier rules (CONTEXT A-05):
//   - perfect      = all participants said 'yes' on that date
//   - withEffort   = (yes + maybe) == participantCount AND at least 1 maybe
//   - oneShort     = yes == participantCount - 1 (one missing or one no)
//
// Range merging: consecutive ≥ 2 days at the same tier collapse into one
// `{ start, end, tier, length }` entry. A break (different tier or missing
// date) ends a range. Sort order: tier weight DESC, length DESC, start ASC.

import type { Poll } from './polls-config';

export type VoteStateRow = 'yes' | 'maybe' | 'no';

export interface VoteRow {
  token: string;
  date: string;
  state: VoteStateRow;
}

export type Tier = 'perfect' | 'withEffort' | 'oneShort';

export interface DateBreakdown {
  yes: number;
  maybe: number;
  no: number;
  unvoted: number;
}

export interface OverlapRange {
  start: string;
  end: string;
  tier: Tier;
  length: number;
}

export interface Overlap {
  perDate: Record<string, DateBreakdown>;
  perfect: string[];
  withEffort: string[];
  oneShort: string[];
  ranges: OverlapRange[];
}

const TIER_WEIGHT: Record<Tier, number> = {
  perfect: 3,
  withEffort: 2,
  oneShort: 1,
};

function enumerateDateRange(start: string, end: string): string[] {
  // Pure string-based date enumeration to avoid TZ-shifting.
  const out: string[] = [];
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  const cur = new Date(Date.UTC(ys, ms - 1, ds));
  const stop = new Date(Date.UTC(ye, me - 1, de));
  while (cur.getTime() <= stop.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function nextIsoDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function tierForDate(
  b: DateBreakdown,
  participantCount: number
): Tier | null {
  if (b.yes === participantCount) return 'perfect';
  if (b.yes + b.maybe === participantCount && b.maybe >= 1) return 'withEffort';
  if (b.yes === participantCount - 1) return 'oneShort';
  return null;
}

export function computeOverlap(poll: Poll, votes: VoteRow[]): Overlap {
  const participantCount = poll.participants.length;
  const allDates = enumerateDateRange(poll.dateRangeStart, poll.dateRangeEnd);

  // Initialise perDate with all dates set to fully-unvoted.
  const perDate: Record<string, DateBreakdown> = {};
  for (const d of allDates) {
    perDate[d] = { yes: 0, maybe: 0, no: 0, unvoted: participantCount };
  }

  // Single pass over votes — only count if date is in range + tally state.
  // Also track which (token, date) pairs have a vote so we can decrement
  // unvoted exactly once per pair.
  for (const v of votes) {
    const bd = perDate[v.date];
    if (!bd) continue; // skip votes outside the poll's date range (defensive)
    bd[v.state]++;
    bd.unvoted--;
    if (bd.unvoted < 0) bd.unvoted = 0; // can happen on bad input; clamp
  }

  // Tier sets — derived from perDate.
  const perfect: string[] = [];
  const withEffort: string[] = [];
  const oneShort: string[] = [];
  for (const d of allDates) {
    const t = tierForDate(perDate[d], participantCount);
    if (t === 'perfect') perfect.push(d);
    else if (t === 'withEffort') withEffort.push(d);
    else if (t === 'oneShort') oneShort.push(d);
  }

  // Range merging — walk all dates, track current run's tier + start.
  // A range only counts if length >= 2 (per CONTEXT A-05).
  const ranges: OverlapRange[] = [];
  let runStart: string | null = null;
  let runTier: Tier | null = null;
  let runLen = 0;
  let prevDate: string | null = null;

  const dateToTier = new Map<string, Tier>();
  for (const d of perfect) dateToTier.set(d, 'perfect');
  for (const d of withEffort) dateToTier.set(d, 'withEffort');
  for (const d of oneShort) dateToTier.set(d, 'oneShort');

  for (const d of allDates) {
    const t = dateToTier.get(d) ?? null;
    const continues =
      runTier !== null && t === runTier && prevDate !== null && nextIsoDay(prevDate) === d;

    if (continues) {
      runLen++;
    } else {
      // Close the previous run if it qualifies.
      if (runStart !== null && runTier !== null && runLen >= 2 && prevDate !== null) {
        ranges.push({ start: runStart, end: prevDate, tier: runTier, length: runLen });
      }
      // Start a new run if this date has a tier.
      if (t !== null) {
        runStart = d;
        runTier = t;
        runLen = 1;
      } else {
        runStart = null;
        runTier = null;
        runLen = 0;
      }
    }
    prevDate = d;
  }
  // Tail run.
  if (runStart !== null && runTier !== null && runLen >= 2 && prevDate !== null) {
    ranges.push({ start: runStart, end: prevDate, tier: runTier, length: runLen });
  }

  ranges.sort((a, b) => {
    const w = TIER_WEIGHT[b.tier] - TIER_WEIGHT[a.tier];
    if (w !== 0) return w;
    const l = b.length - a.length;
    if (l !== 0) return l;
    return a.start.localeCompare(b.start);
  });

  return { perDate, perfect, withEffort, oneShort, ranges };
}
