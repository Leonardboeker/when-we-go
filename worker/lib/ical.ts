// worker/lib/ical.ts
// Hand-rolled RFC 5545 (.ics) builder. No external library — calendar parsers
// are strict but the spec subset we need is small.
//
// Key invariants enforced here:
//   1. CRLF (`\r\n`) line endings — Google Calendar + Apple Calendar reject LF.
//   2. DTEND is EXCLUSIVE for all-day events. Jul 12-15 inclusive trip becomes
//      `DTSTART;VALUE=DATE:20260712` / `DTEND;VALUE=DATE:20260716`.
//   3. UID is stable per poll (`<slug>@when-we-go`) so re-importing replaces
//      the existing event instead of creating duplicates.
//   4. 4 VALARM blocks (DISPLAY action, cross-platform safe) at T-30d / T-7d
//      / T-1d / T-2h offsets.
//   5. Special chars in SUMMARY/DESCRIPTION/LOCATION are escaped per RFC 5545
//      §3.3.11 (backslash, comma, semicolon, newline).

export interface ICalEventInput {
  /** Stable UID — typically `<slug>@when-we-go`. */
  uid: string;
  /** Inclusive trip start date, ISO YYYY-MM-DD. */
  tripStartIso: string;
  /** EXCLUSIVE end date, ISO YYYY-MM-DD. Pass tripEnd+1day for all-day events. */
  tripEndExclusiveIso: string;
  /** Event title — escapeICalText is applied internally. */
  summary: string;
  /** Multi-line allowed (`\n`); escapeICalText handles it. */
  description: string;
  /** Free-form location string. */
  location: string;
  /** Optional ATTENDEE block. Skipped if absent (for the public shareable .ics). */
  attendee?: {
    name: string;
    email: string;
  };
  /** Defaults to `STATUS:CONFIRMED`. */
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
}

/**
 * Escape a string for safe embedding in an .ics text field per RFC 5545 §3.3.11.
 * Order matters — escape `\` first so we don't double-escape our own substitutions.
 */
export function escapeICalText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

/** Format an ISO date `YYYY-MM-DD` as iCal `YYYYMMDD` (all-day form). */
export function formatICalDate(iso: string): string {
  return iso.replace(/-/g, '');
}

/** Format a Date as iCal UTC timestamp `YYYYMMDDTHHMMSSZ`. */
export function formatICalDateTime(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

/**
 * Add `days` to an ISO date and return the result as ISO `YYYY-MM-DD`.
 * Used to convert an inclusive trip end (e.g. Jul 15) into the exclusive
 * DTEND value (Jul 16) for all-day VEVENT.
 */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

const CRLF = '\r\n';

/**
 * Build a complete VCALENDAR string for one trip event. Returns a single
 * CRLF-terminated string ready for `Content-Type: text/calendar` responses
 * or for base64-embedding as an email attachment.
 */
export function buildICalForPoll(input: ICalEventInput): string {
  const status = input.status ?? 'CONFIRMED';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//when-we-go//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${formatICalDateTime(new Date())}`,
    `DTSTART;VALUE=DATE:${formatICalDate(input.tripStartIso)}`,
    `DTEND;VALUE=DATE:${formatICalDate(input.tripEndExclusiveIso)}`,
    `SUMMARY:${escapeICalText(input.summary)}`,
    `DESCRIPTION:${escapeICalText(input.description)}`,
    `LOCATION:${escapeICalText(input.location)}`,
    'ORGANIZER;CN=when-we-go:mailto:noreply@when-we-go.app',
  ];

  if (input.attendee) {
    // CN must be escaped too — names containing semicolons or commas would
    // otherwise corrupt the line.
    const cn = escapeICalText(input.attendee.name);
    lines.push(`ATTENDEE;CN=${cn};RSVP=FALSE:mailto:${input.attendee.email}`);
  }

  lines.push(`STATUS:${status}`);

  // 4 VALARM blocks — DISPLAY action is the cross-platform-safe choice.
  // TRIGGER uses relative durations (ISO 8601 duration format with leading `-`).
  const summaryShort = escapeICalText(input.summary);
  const alarms: Array<{ trigger: string; desc: string }> = [
    { trigger: '-P30D', desc: `Trip in 30 days — ${summaryShort}` },
    { trigger: '-P7D', desc: `Trip in 1 week — ${summaryShort}` },
    { trigger: '-P1D', desc: `Trip tomorrow — ${summaryShort}` },
    { trigger: '-PT2H', desc: `Trip starts in 2h — ${summaryShort}` },
  ];
  for (const a of alarms) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${a.desc}`,
      `TRIGGER:${a.trigger}`,
      'END:VALARM'
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // Trailing CRLF after END:VCALENDAR is recommended by some parsers.
  return lines.join(CRLF) + CRLF;
}
