// src/lib/calendar.ts
// Pure date helpers for the CalendarGrid. No DOM, no Astro, easy to unit-test.
// Dates are ISO YYYY-MM-DD strings (full-day granularity — see D-04).

// Mon-first weekday index: 0=Mon, 1=Tue ... 6=Sun.
// (JS Date.getDay() returns 0=Sun, so we shift.)
const MONDAY_FIRST_INDEX: Record<number, number> = {
  0: 6, // Sun → 6
  1: 0, // Mon → 0
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5, // Sat → 5
};

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Pad a number to 2 digits with leading zero. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Convert a UTC midnight Date back to YYYY-MM-DD. */
function dateToIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Parse YYYY-MM-DD into a UTC-midnight Date. Throws on bad input. */
function parseIso(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`calendar: invalid ISO date "${value}"`);
  }
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** All dates from start..end inclusive, as ISO strings. */
export function enumerateDays(start: string, end: string): string[] {
  const startDate = parseIso(start);
  const endDate = parseIso(end);
  if (endDate.getTime() < startDate.getTime()) {
    throw new Error(`calendar: end "${end}" is before start "${start}"`);
  }
  const out: string[] = [];
  const cur = new Date(startDate.getTime());
  while (cur.getTime() <= endDate.getTime()) {
    out.push(dateToIso(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** True if the ISO date falls on Saturday or Sunday. */
export function isWeekend(date: string): boolean {
  const d = parseIso(date);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Format an ISO date as a month header (e.g. "June 2026"). */
export function monthHeader(date: string): string {
  const d = parseIso(date);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Mon-first weekday index for an ISO date (0=Mon..6=Sun). */
export function mondayIndex(date: string): number {
  const d = parseIso(date);
  return MONDAY_FIRST_INDEX[d.getUTCDay()];
}

export type Week = {
  /** ISO date of the Monday that starts this week (may pre-date dateRangeStart). */
  weekStart: string;
  /** 7 entries; null = padding day outside dateRangeStart..dateRangeEnd. */
  days: (string | null)[];
};

/** Group a list of ISO dates into Mon-first weeks, padding with nulls. */
export function groupByWeek(days: string[]): Week[] {
  if (days.length === 0) return [];

  const weeks: Week[] = [];
  // Compute the Monday on or before the first day.
  const firstIdx = mondayIndex(days[0]);
  const firstDate = parseIso(days[0]);
  const weekStartDate = new Date(firstDate.getTime());
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - firstIdx);

  // Build a Set for fast in-range lookups.
  const inRange = new Set(days);
  const lastDate = parseIso(days[days.length - 1]);

  const cursor = new Date(weekStartDate.getTime());
  while (cursor.getTime() <= lastDate.getTime()) {
    const weekStart = dateToIso(cursor);
    const slots: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(cursor.getTime());
      day.setUTCDate(day.getUTCDate() + i);
      const iso = dateToIso(day);
      slots.push(inRange.has(iso) ? iso : null);
    }
    weeks.push({ weekStart, days: slots });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return weeks;
}

/** True if the ISO date equals today (in UTC). Phase 2 may swap to viewer's TZ. */
export function isToday(date: string, now: Date = new Date()): boolean {
  const today = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(
    now.getUTCDate()
  )}`;
  return date === today;
}

/** Whole days remaining from `now` until `pollCloseAt`. Clamped at 0. */
export function daysUntil(closeIso: string, now: Date = new Date()): number {
  const close = Date.parse(closeIso);
  if (!Number.isFinite(close)) return 0;
  const diff = close - now.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
