// worker/lib/ical.test.ts
// Unit tests for the RFC 5545 .ics builder. Run via:
//   node --test worker/lib/ical.test.ts
//
// Coverage targets:
//   1. Valid VCALENDAR header + body skeleton
//   2. CRLF line endings everywhere (strict per spec)
//   3. All 4 VALARM blocks (T-30d, T-7d, T-1d, T-2h) are present
//   4. Special chars in SUMMARY/DESCRIPTION/LOCATION are escaped per §3.3.11
//   5. ATTENDEE block omitted when no attendee passed (public .ics)
//   6. DTEND uses the EXCLUSIVE date (caller must pre-compute via addDaysIso)
//   7. addDaysIso correctness for month rollover

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  buildICalForPoll,
  escapeICalText,
  formatICalDate,
  formatICalDateTime,
} from './ical.ts';

test('buildICalForPoll — valid VCALENDAR header + body skeleton', () => {
  const ics = buildICalForPoll({
    uid: 'copenhagen-2026@when-we-go',
    tripStartIso: '2026-07-12',
    tripEndExclusiveIso: '2026-07-16',
    summary: 'Copenhagen — family trip',
    description: 'See details inside.',
    location: 'Copenhagen, Denmark',
  });

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), 'starts with VCALENDAR opener');
  assert.match(ics, /VERSION:2\.0\r\n/);
  assert.match(ics, /PRODID:-\/\/when-we-go\/\/EN\r\n/);
  assert.match(ics, /BEGIN:VEVENT\r\n/);
  assert.match(ics, /UID:copenhagen-2026@when-we-go\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260712\r\n/);
  // DTEND is exclusive — caller pre-computed Jul 16 from Jul 15 inclusive.
  assert.match(ics, /DTEND;VALUE=DATE:20260716\r\n/);
  assert.match(ics, /STATUS:CONFIRMED\r\n/);
  assert.match(ics, /END:VEVENT\r\n/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'), 'ends with VCALENDAR closer');
});

test('buildICalForPoll — CRLF line endings everywhere (strict per RFC 5545)', () => {
  const ics = buildICalForPoll({
    uid: 'tokyo-2027@when-we-go',
    tripStartIso: '2027-04-01',
    tripEndExclusiveIso: '2027-04-08',
    summary: 'Tokyo cherry blossoms',
    description: 'multi\nline\ndescription',
    location: 'Tokyo, Japan',
  });

  // Every internal newline must be CRLF, not bare LF.
  // Strategy: remove all \r\n, then assert no \n remains.
  const withoutCrlf = ics.replace(/\r\n/g, '');
  assert.ok(
    !withoutCrlf.includes('\n'),
    `bare LF found in iCal output — must be CRLF only. Hex preview: ${Buffer.from(withoutCrlf.slice(0, 80)).toString('hex')}`
  );
  // And the multi-line description should have been escaped to literal `\n`
  // (the two-char sequence backslash-n), not contain a real newline.
  assert.match(ics, /DESCRIPTION:multi\\nline\\ndescription\r\n/);
});

test('buildICalForPoll — all 4 VALARM blocks present with correct triggers', () => {
  const ics = buildICalForPoll({
    uid: 'rome-2026@when-we-go',
    tripStartIso: '2026-09-01',
    tripEndExclusiveIso: '2026-09-05',
    summary: 'Rome long weekend',
    description: '',
    location: 'Rome',
  });

  // Count VALARM blocks.
  const alarmBegins = ics.match(/BEGIN:VALARM\r\n/g) ?? [];
  const alarmEnds = ics.match(/END:VALARM\r\n/g) ?? [];
  assert.equal(alarmBegins.length, 4, 'exactly 4 VALARM opens');
  assert.equal(alarmEnds.length, 4, 'exactly 4 VALARM closes');

  // Each trigger present.
  assert.match(ics, /TRIGGER:-P30D\r\n/, 'has -P30D');
  assert.match(ics, /TRIGGER:-P7D\r\n/, 'has -P7D');
  assert.match(ics, /TRIGGER:-P1D\r\n/, 'has -P1D');
  assert.match(ics, /TRIGGER:-PT2H\r\n/, 'has -PT2H');

  // All ACTION:DISPLAY (cross-platform safe — Apple/Google/Outlook all accept).
  const actionMatches = ics.match(/ACTION:DISPLAY\r\n/g) ?? [];
  assert.equal(actionMatches.length, 4, 'all 4 alarms use ACTION:DISPLAY');
});

test('escapeICalText — escapes backslash, comma, semicolon, newlines per §3.3.11', () => {
  // Order matters: backslash must be escaped first so we don't double-escape
  // our own substitutions.
  assert.equal(escapeICalText('foo,bar'), 'foo\\,bar');
  assert.equal(escapeICalText('a;b'), 'a\\;b');
  assert.equal(escapeICalText('back\\slash'), 'back\\\\slash');
  assert.equal(escapeICalText('one\ntwo'), 'one\\ntwo');
  assert.equal(escapeICalText('a\r\nb'), 'a\\nb');
  // Combined.
  assert.equal(escapeICalText('a, b; c\\d\ne'), 'a\\, b\\; c\\\\d\\ne');
});

test('buildICalForPoll — escapes special chars inside the actual output', () => {
  const ics = buildICalForPoll({
    uid: 'special-2026@when-we-go',
    tripStartIso: '2026-07-12',
    tripEndExclusiveIso: '2026-07-16',
    summary: 'Trip; comma, and backslash\\',
    description: 'Line1\nLine2',
    location: 'City, Country',
  });
  assert.match(ics, /SUMMARY:Trip\\; comma\\, and backslash\\\\\r\n/);
  assert.match(ics, /DESCRIPTION:Line1\\nLine2\r\n/);
  assert.match(ics, /LOCATION:City\\, Country\r\n/);
});

test('buildICalForPoll — ATTENDEE present when participant given, absent otherwise', () => {
  const withAttendee = buildICalForPoll({
    uid: 'with@when-we-go',
    tripStartIso: '2026-07-12',
    tripEndExclusiveIso: '2026-07-13',
    summary: 'x',
    description: '',
    location: '',
    attendee: { name: 'Sister', email: 'sis@example.com' },
  });
  assert.match(withAttendee, /ATTENDEE;CN=Sister;RSVP=FALSE:mailto:sis@example\.com\r\n/);

  const withoutAttendee = buildICalForPoll({
    uid: 'without@when-we-go',
    tripStartIso: '2026-07-12',
    tripEndExclusiveIso: '2026-07-13',
    summary: 'x',
    description: '',
    location: '',
  });
  assert.ok(!withoutAttendee.includes('ATTENDEE'), 'public .ics has no ATTENDEE block');
});

test('formatICalDate / formatICalDateTime', () => {
  assert.equal(formatICalDate('2026-07-12'), '20260712');
  const d = new Date(Date.UTC(2026, 6, 29, 12, 30, 45));
  assert.equal(formatICalDateTime(d), '20260729T123045Z');
});

test('addDaysIso — handles month + year rollover', () => {
  assert.equal(addDaysIso('2026-07-15', 1), '2026-07-16');
  assert.equal(addDaysIso('2026-07-31', 1), '2026-08-01');
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysIso('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
});
