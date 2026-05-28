# Phase 8 Plan — Email + iCal Close-Summary

> Atomic tasks. CONTEXT in same dir. All paths relative to `D:/dev/when-we-go/`.
> Real Resend key is in `.dev.vars` — Phase 8 can smoke-test against the actual Resend API.

## Tasks

### T-01 — Port Resend client
**Files:** `worker/lib/resend.ts` (new)

Adapt pay-me-back's `D:/dev/pay-me-back-template/worker/lib/resend.ts` for when-we-go: same shape, supports `attachments` param. 5s timeout, fail-closed (returns `{ok: false, error}`). No throws.

### T-02 — Notification pipeline extension
**Files:** `worker/lib/notify-pipeline.ts` (modify)

Existing pipeline does Telegram-only. Add Resend fan-out:
- New helper `sendEmail(env, {to, subject, html, text, attachments?})` — wraps Resend client, silently skips if `WHENWEGO_RESEND_API_KEY` unset
- Adapt `notifyFirstVote` + `notifyPollClose` to ALSO fire emails when configured (not just Telegram)

### T-03 — iCal generation
**Files:** `worker/lib/ical.ts` (new)

Hand-rolled per RFC 5545:
- `buildICalForPoll(poll, participant?, tripStart, tripEndExclusive, locationStr)` → returns full `BEGIN:VCALENDAR\r\n...\r\nEND:VCALENDAR` string
- VEVENT with `UID:<slug>@when-we-go`, `DTSTAMP`, all-day DTSTART/DTEND, SUMMARY, DESCRIPTION (multi-line `\n` escaped), LOCATION, optional ATTENDEE (if participant has email), STATUS:CONFIRMED
- 4 VALARM blocks: -P30D, -P7D, -P1D, -PT2H (all ACTION:DISPLAY)
- CRLF line endings
- Helper: `formatICalDate(isoDate): string` → `YYYYMMDD`
- Helper: `formatICalDateTime(date): string` → `YYYYMMDDTHHMMSSZ`
- Helper: `escapeICalText(s)` → escape `\`, `,`, `;`, newlines

### T-04 — iCal endpoint
**Files:** `worker/handlers/ical.ts` (new), wire in `worker/index.ts`

`GET /api/ical?slug=X&token=Y` (Y optional):
- If token = participant token → personalised .ics with ATTENDEE block
- If token = organiser token → admin-personalised
- If token missing → public minimal .ics (no ATTENDEE)
- Returns `Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="<slug>.ics"`, `Cache-Control: public, max-age=300`

Also add `GET /ical/<slug>.ics` route (no token, public minimal) — for embedding in close email and add-to-calendar share-links.

### T-05 — Add-to-calendar URL builders
**Files:** `worker/lib/calendar-links.ts` (new), `src/lib/calendar-links.ts` (mirror for client)

Pure functions:
- `buildGoogleCalendarUrl({title, startDate, endDateExclusive, description, location})` 
- `buildOutlookUrl(...)` 
- `buildYahooUrl(...)` 
- `buildICalDownloadUrl({siteUrl, slug})` → just `${siteUrl}/ical/${slug}.ics`
- All return absolute URLs

Same code on both worker + client sides (export both, or share via `src/lib`).

### T-06 — Email template — close summary
**Files:** `worker/lib/email-templates.ts` (new)

Export `renderCloseSummaryEmail({poll, participant, profile, overlap, flights?, hotels?, activities?, siteUrl})` → `{ subject, html, text, attachments }`:
- HTML: table-based, max-width 600px, single-column, mobile-responsive via `@media`
- Sections (conditional):
  - Header banner (absolute URL to `${siteUrl}/banner.png`)
  - Greeting: "Hey {name} — Copenhagen is set for July 12-15."
  - Add-to-calendar buttons row: Google / Apple (link to .ics) / Outlook / Yahoo
  - FLIGHTS section if `flights?.length > 0` (Phase 5 fills this; empty in Phase 8 isolation = section omitted)
  - HOTELS section if `hotels?.length > 0` (Phase 6)
  - ACTIVITIES section if `activities?.thisWeek?.length || activities?.alwaysGreat?.length`
  - "We'll ping you" reminder preview (T-30 / T-7 / T-1 / T+1 explanation)
  - Footer: link back to per-token page + "you're getting this because <organiser_name> set up a poll for <destination>"
- Plain-text fallback: regex-strip HTML, links inline as `Text [http://...]`
- Attachment: .ics file as base64

Subject line: `🎉 ${destination} is set — ${rangeShort}` (e.g. "🎉 Copenhagen is set — Jul 12-15")

### T-07 — Close-trigger extension
**Files:** `worker/scheduled.ts`, `worker/handlers/admin-close.ts`

After `closeNow()` succeeds, for each participant with `profile.email`:
- Build close-summary email (flights/hotels/activities = empty arrays for Phase 8 isolation — Phases 5-7 will populate later)
- `ctx.waitUntil(sendEmail({to: profile.email, ...rendered}))`
- Don't block on email sends

Log per-participant send result to console (for now; later DO email_log table is Phase 9 nice-to-have).

### T-08 — Resend close-summary admin endpoint
**Files:** `worker/handlers/admin-resend-summary.ts` (new), wire route

`POST /api/admin/resend-close-summary?slug=X` (organiser-token gated):
- For closed polls: re-fire close-summary email for all participants with emails
- Useful when profile-completion happens AFTER close (Phase 4 allows that)

### T-09 — Demo banner + footer updates
**Files:** `src/components/EmailButtons.astro` (new, optional — render add-to-calendar buttons on the participant page too)

Post-close participant page shows the same 4 add-to-calendar buttons inline (not just in email). Lets people add to calendar even if they missed the email.

### T-10 — Smoke test extension
**Files:** `scripts/smoke-test.mjs`

Add:
- `GET /api/ical?slug=X&token=Y` → 200 + Content-Type text/calendar + starts with `BEGIN:VCALENDAR`
- `GET /ical/<slug>.ics` → 200 + same
- `POST /api/admin/resend-close-summary` with org token + closed poll → 200 + `{ ok, sent: N }`
- `POST /api/admin/resend-close-summary` with wrong org token → 404

For the actual email test: spam less. Set a participant's email to `test@nowhere.invalid` via `/api/profile`, then close → assert Resend API was called (will get 422 "can only send to verified addresses" but that confirms the integration runs).

### T-11 — Build verify + smoke
1. `npm run build` → 7+ static pages
2. `node scripts/verify-isolation.mjs` → exit 0
3. `node --test worker/lib/overlap.test.ts` → 8/8
4. `npx wrangler deploy --dry-run` → clean compile
5. `wrangler dev` + smoke → all gates green, new iCal + admin-resend checks pass

## Acceptance

- `.ics` files validate (importable into Apple Calendar / Google Calendar manually, or via online validators like https://icalendar.org/validator.html)
- Close fires real Resend API call when participant has email set (even if email bounces to unverified address — call succeeds at API level)
- Add-to-calendar buttons produce working URLs (manual click → opens calendar UI with event prefilled)
- Email template renders cleanly in known clients (test by inspecting HTML — table-based layout, no broken tags)
- When Resend key unset: email pipeline silently skips, Telegram-only still works
- Phase 4 + earlier smoke tests still pass
