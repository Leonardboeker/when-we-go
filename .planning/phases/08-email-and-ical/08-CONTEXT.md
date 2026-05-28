# Phase 8 Context — Email + iCal Close-Summary

> The user's explicit ask: when the poll closes, every participant gets a personalised email with trip details, flight/hotel/activity proposals, and one-click "Add to Calendar" buttons + an .ics file with device-local reminders baked in.

## Goal

End-to-end notification at poll close:
1. **Personalised email per participant** (Resend) — their flights, shared hotels, shared activities, calendar add-links, .ics attachment, reminder preview
2. **iCal (.ics) generation per poll** — RFC 5545 compliant, with VALARM blocks for device-local reminders
3. **Add-to-calendar deep-links** — Google Calendar, Outlook Web, Apple Calendar, Yahoo (URL-based, no OAuth)

## Decisions

### D-01 — Email infrastructure: Resend

Mirror pay-me-back's `worker/lib/resend.ts`:

```ts
export async function sendResendEmail(params: {
  apiKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  attachments?: { filename: string; content_base64: string; content_type: string }[];
}): Promise<{ ok: boolean; error?: string }>
```

Env vars:
- `WHENWEGO_RESEND_API_KEY` (secret)
- `WHENWEGO_RESEND_FROM` — e.g. `"when-we-go <hello@your-domain.com>"`. Fallback to `"when-we-go <onboarding@resend.dev>"` (sandbox — only sends to verified-recipient addresses).
- `WHENWEGO_SITE_URL` — absolute base URL for links inside emails (must be absolute; relative URLs don't work in email)

If `WHENWEGO_RESEND_API_KEY` unset → email pipeline silently skipped (Telegram-only mode). Mirrors pay-me-back's pattern.

### D-02 — Email template

`worker/lib/email-templates.ts` exports:

```ts
renderCloseSummaryEmail({
  poll: Poll,
  participant: Participant,
  profile: ParticipantProfile,
  overlap: Overlap,
  flights: FlightOption[],          // their personalised flights, [] if not configured
  hotels: HotelOption[],            // shared shortlist
  activities: { thisWeek: [], alwaysGreat: [] },
  icalUrl: string,                  // absolute URL to /api/ical?slug=X&token=Y
  participantPageUrl: string,       // absolute URL back to their token page
  addToCalendarLinks: {
    google: string; outlook: string; yahoo: string; ical: string;
  }
}): { subject: string; html: string; text: string; attachments: Attachment[] }
```

**HTML email design** (~200 lines):
- Table-based layout (still the email-client standard — div+flex breaks Outlook)
- Single-column, max-width 600px
- Top: pixel-art header banner (absolute URL to `/banner.png`)
- Greeting + dates as biggest text element
- Sections (flights / hotels / activities) — each table-row with subtle border, no fancy CSS
- "Add to Calendar" buttons: 4 buttons in a row, color-keyed by service brand (Google blue, Apple grey, Outlook blue, Yahoo purple)
- Reminders preview block ("we'll ping you 30/7/1 day before")
- Footer: link to per-token page + "you're getting this because <organiser_name> set up a when-we-go poll for <destination>"
- Plain-text fallback auto-generated: strip HTML, keep links inline as `Text [http://...]`

**Mobile-responsive** via:
```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @media (max-width: 600px) {
    .stack-on-mobile { display: block !important; width: 100% !important; }
  }
</style>
```

### D-03 — Subject lines

| Trigger | Subject (with example values) |
|---|---|
| Close summary | `🎉 Copenhagen is set — Jul 12-15` |
| (later Phase 9) T-30 reminder | `🗓 Copenhagen in 1 month — refreshed flight prices` |
| (later) T-7 reminder | `🎒 Copenhagen next week — quick checklist` |
| (later) T-1 reminder | `✈️ Copenhagen tomorrow!` |
| (later) T+1 follow-up | `Hope Copenhagen was great. Want to plan another?` |

Emoji at start = fine for transactional, helps subject scanning in mobile inbox.

### D-04 — iCal (.ics) generation

`worker/lib/ical.ts` — hand-rolled per RFC 5545, no library:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//when-we-go//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
UID:<slug>@when-we-go
DTSTAMP:<now in UTC, format 20260729T120000Z>
DTSTART;VALUE=DATE:20260712
DTEND;VALUE=DATE:20260716
SUMMARY:Copenhagen — family trip
DESCRIPTION:Hotel: Skt Petri\nFlights: see https://...\nFull details: https://...
LOCATION:Copenhagen, Denmark
ORGANIZER;CN=when-we-go:mailto:noreply@when-we-go.app
ATTENDEE;CN=Sister;RSVP=FALSE:mailto:sister@example.com
STATUS:CONFIRMED
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Trip in 30 days — Copenhagen
TRIGGER:-P30D
END:VALARM
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Trip in 1 week — Copenhagen
TRIGGER:-P7D
END:VALARM
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Trip tomorrow — Copenhagen
TRIGGER:-P1D
END:VALARM
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Trip starts in 2h — Copenhagen
TRIGGER:-PT2H
END:VALARM
END:VEVENT
END:VCALENDAR
```

Notes:
- DTEND is **exclusive** for all-day events per RFC — Jul 12-15 inclusive trip = DTSTART Jul 12, DTEND Jul 16
- UID must be stable per poll — slug + "@when-we-go" guarantees uniqueness + idempotent updates if we re-send a .ics (calendar apps treat same UID as same event, just update)
- Line endings MUST be CRLF (`\r\n`); calendar parsers are strict
- Long lines should fold at 75 chars with leading space on continuation (most parsers tolerate non-folded; we can skip for simplicity)
- VALARM uses ACTION:DISPLAY for cross-platform compatibility (Apple supports AUDIO, Google ignores it, DISPLAY works everywhere)

### D-05 — iCal endpoint

`worker/handlers/ical.ts` → `GET /api/ical?slug=X&token=Y`:

```ts
return new Response(icalString, {
  status: 200,
  headers: {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="${slug}.ics"`,
    'Cache-Control': 'public, max-age=300', // 5min — content rarely changes
  }
});
```

Public route alias: `GET /ical/<slug>.ics` redirects to `/api/ical?slug=<slug>` (for shareable add-to-calendar URLs that don't expose the token).

**Privacy:** The shareable `/ical/<slug>.ics` returns a minimal .ics (no ATTENDEE list, no token in description). The per-token `/api/ical?slug=X&token=Y` returns the full personalised version with the participant's name in ATTENDEE.

### D-06 — Add-to-calendar URL builders

`worker/lib/calendar-links.ts`:

```ts
export function buildGoogleCalendarUrl({title, start, end, description, location}): string {
  const dates = `${formatDateGoog(start)}/${formatDateGoog(end)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates,
    details: description,
    location
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildOutlookUrl({title, start, end, description, location}): string {
  const params = new URLSearchParams({
    subject: title,
    startdt: new Date(start).toISOString(),
    enddt: new Date(end).toISOString(),
    body: description,
    location
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function buildYahooUrl({title, start, end, description, location}): string {
  const params = new URLSearchParams({
    v: '60',
    title,
    st: formatDateYahoo(start),
    et: formatDateYahoo(end),
    desc: description,
    in_loc: location
  });
  return `https://calendar.yahoo.com/?${params.toString()}`;
}

export function buildAppleUrl(icalAbsoluteUrl: string): string {
  // Apple Calendar handles .ics natively via download
  return icalAbsoluteUrl;
}
```

Format helpers: Google wants `YYYYMMDDTHHMMSSZ`, Outlook wants ISO 8601, Yahoo wants `YYYYMMDDTHHMMSSZ` (same as Google).

### D-07 — Trigger flow at close

`worker/scheduled.ts` `closePoll()` extended:

1. (Existing) Compute overlap, write to DO, fire Telegram close-summary
2. **NEW: For each participant in parallel:**
   - Skip if `profile.email` unset
   - Build `closeSummaryParams` (poll, participant, profile, overlap, flights[token], hotels, activities, icalUrl, addToCalendarLinks)
   - Call `renderCloseSummaryEmail(...)` → `{subject, html, text, attachments}`
   - Call `sendResendEmail(...)` via `ctx.waitUntil(...)` (don't block cron on slow email sends)
   - On success: log; on failure: log + maybe Telegram-ping organiser ("email to Sister bounced — check her address")

Race: Phase 5/6/7 also fetch on close. Order:
1. Close + compute overlap (Phase 2 — sync)
2. Fire flights/hotels/activities fetches in parallel (Phase 5/6/7) — `await Promise.allSettled(...)`
3. Once all done (or 30s timeout), build emails using whatever's cached
4. Fire emails via `ctx.waitUntil` (don't await — let cron finish)

If a proposal layer (e.g. flights) failed → email gracefully shows "Flight options will arrive separately" instead of empty section.

### D-08 — Email template sections (conditional)

```
Always shown:
- Header banner
- Greeting + dates
- Add-to-calendar buttons (Phase 8 always works)
- Reminders preview (links to manage them)
- Footer

Conditionally shown:
- Flights section — only if flights.length > 0
- Hotels section — only if hotels.length > 0
- Activities section — only if activities.thisWeek + alwaysGreat have entries
- "Flight options coming separately" — only if flights fetch failed
```

This way Phase 8 works in isolation (before 5/6/7 are built) — email just shows dates + calendar links + reminders.

### D-09 — Reminder preview block

In the close-summary email, a small block:

```
🔔 Reminders we'll send:
- 30 days before — flight price refresh
- 1 week before — packing checklist
- 1 day before — final details
- 1 day after — wrap-up

Calendar alerts are also baked into your .ics file (above).
```

Phase 9 implements the actual sending; Phase 8 just promises it in the email.

### D-10 — Webhooks / delivery tracking

Resend offers `webhook` events for `delivered` / `bounced` / `opened`. For MVP:
- **In scope:** log all email-send results (success / failure + reason) to a DO table `email_log (timestamp, token, type, status, error?)`
- **Out of scope:** wiring up Resend webhooks for delivery confirmation (adds new endpoint + DO writes; defer to Phase 9b if it matters)

If an email bounces, organiser will notice eventually (participant says "I didn't get anything"); not worth the complexity for friend-group scale.

## API surface added

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/ical?slug=X&token=Y` | participant token | Personalised .ics with full event + ATTENDEE block |
| GET | `/ical/<slug>.ics` | none (rewrite) | Public-shareable minimal .ics |
| POST | `/api/admin/resend-close-summary?slug=X` | organiser | Re-fire close-summary emails (e.g. after profile updates) |

## Cost / free-tier math

Per 4-person poll:
- 4 close-summary emails @ 1 each = 4
- 4 .ics generations (already cached in DO, just embed in email)
- Phase 9 will add 4 × 4 reminders = 16 more

Total per poll: ~20 emails. Resend free tier: 3000/mo → 150 polls/month. Plenty.

## Edge cases

- Participant has email but it bounces → log, alert organiser via Telegram if configured
- Email has 0 flights + 0 hotels + 0 activities → still useful (dates + calendar links + reminders preview)
- Participant changes email after close → call `POST /api/admin/resend-close-summary` to re-send
- `.ics` opened on a clock-skewed device → DTSTAMP in UTC is fine; events render in user's local TZ
- Multiple participants share an email (parent + kid) → fine, each gets their own email (Resend handles duplicates as separate sends)
- TZ for the event: poll's destination TZ. If unmappable (custom destination string), default to Europe/Berlin.

## What's intentionally NOT in this phase

- Email template editing UI for the organiser (defer; copy is fine for first cut)
- Internationalization of email copy (English only; German for Leo's family via string-table swap)
- Calendar-app native invitations (e.g. Google Calendar invite-via-email with RSVP buttons) — needs OAuth, defer; .ics download covers 95%
- Push notifications via web-push API — overkill, .ics + email reminders are enough
- Email read-receipts beyond Resend's basic delivery log — privacy creep, skip

## Acceptance criteria

1. After `POST /api/admin/close` on a poll with 4 participants who all have profiles: each receives one email within 60s
2. Email renders cleanly in: Gmail web, Apple Mail iOS, Outlook web, plain-text-only mode
3. .ics attachment imports cleanly into Google Calendar, Apple Calendar, Outlook
4. Add-to-calendar buttons open the correct calendar with the event prefilled (manual click-through test)
5. Imported event has 4 VALARM blocks (30d, 7d, 1d, 2h before) — verified by inspecting the imported event's alarm settings
6. If `WHENWEGO_RESEND_API_KEY` unset → no emails sent, no errors, log line per skipped send
7. Existing 14/14 smoke tests still green; new test for `/api/ical` returns valid .ics
