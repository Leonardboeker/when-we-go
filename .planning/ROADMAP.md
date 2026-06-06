# Roadmap

> Master phase list. All 10 phases shipped. Full trip planner complete. — see [`VISION.md`](./VISION.md) for the full picture and architecture.
> Per-phase implementation details live in `phases/NN-<name>/NN-CONTEXT.md` written just-in-time.

## Phase status overview

| # | Phase | Goal | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | Foundation | Astro skeleton, token model, static pages | ✅ done | — | — |
| 2 | Date Polling + Auto-Close | Worker + DO + interactive grid + cron | ✅ done | — | 1 |
| 3 | Polish + Public Release | README, banner, OG images, demo, public flip | ✅ done | — | 2 |
| 4 | Participant Profile | Collect email + home airport + budget + interests | ✅ done | 1 day | 2 |
| 5 | Flight Search | Kiwi.com Tequila (real) + Mock provider fallback | ✅ done | 2 days | 4 |
| 6 | Hotel Search | Provider-abstracted shared hotel shortlist | ✅ done | 1 day | 5 |
| 7 | Activity Suggestions | Claude Haiku via tools API + Mock fallback | ✅ done | 1 day | 2 |
| 8 | Email + iCal Close-Summary | Resend + RFC 5545 .ics + add-to-calendar links | ✅ done | 2 days | 5, 6, 7 |
| 9 | Reminder Schedule | Cron T-30/T-7/T-1/T+1 with idempotency | ✅ done | 1 day | 8 |
| 10 | pay-me-back Integration | Cost split export + one-click pay-me-back JSON | ✅ done | 2 days | 9 |
| 11 | (Future) Booking deep-links | Direct links to Booking.com / Airbnb prefilled with dates | future | — | 6 |
| 12 | (Future) Conversational refinement | "show me cheaper flights" — multi-turn LLM | future | — | 7 |

Phases 11-12 are **future, not planned**. If when-we-go actually gets used and adopters request them — revisit.

---

## Phase 4 — Participant Profile

**Goal:** Expand `Participant` schema to collect the data needed for personalised proposals + email delivery.

**User-facing flow:**
- Participant opens token URL → if profile incomplete, see one-screen onboarding form before the calendar grid
- Form fields: email (required for Phase 8+), home airport (IATA autocomplete from a bundled list, required for Phase 5+), optional budget cap (€/person, three-step preset 200/500/1000/no-limit), optional interests (multi-select: museums, outdoors, food, nightlife, history, festivals)
- Submit → POST `/api/profile` → DO stores → calendar grid revealed
- Returning participants skip the form (profile already complete)
- Organiser dashboard shows per-participant profile-completeness indicator

**Tech:**
- Extend `Participant` type in `src/data/polls.ts`: add `?email`, `?homeAirport`, `?budgetMaxEur`, `?interests`
- Profile data lives in DO `participant_profile` table (NOT in `polls.json` — too sensitive, would commit emails to git)
- New endpoint `POST /api/profile { slug, token, profile }` — same auth as `/api/vote`
- New endpoint includes profile in `GET /api/poll` response
- Onboarding component: `src/components/ProfileForm.astro` — vanilla JS form, validates IATA airport against bundled list (`src/data/airports.json` — ~5MB but tree-shake to top-200 by traffic)

**Edge cases:**
- Participant who already voted in Phase 1-3 has no profile → on next visit, prompt for it (calendar grid hidden until they submit)
- Profile changes mid-poll → re-run flight search at next reminder tick
- Email omitted → email pipeline silently skips that participant (Telegram-only flow)

**Acceptance:**
- Participant page shows form on first visit, grid on returning visits
- Profile persists in DO across reloads + browser quits
- Organiser sees "3/4 profiles complete" indicator
- `GET /api/poll` returns viewer's own profile (never others')

---

## Phase 5 — Flight Search (Amadeus)

**Goal:** Once poll closes, auto-fetch flight options for each participant from their home airport to the destination, on the locked dates.

**User-facing:**
- Post-close `/api/poll` response includes a `flights` field per-participant: `[{ airline, durationMin, stops, priceEur, bookingHint }, ...]`
- Top 3 cheapest + top 3 fastest, sorted with cheap-first highlighted
- Refresh button on participant page → re-fetches latest prices (rate-limited to 1/hour per participant)

**Tech:**
- `worker/lib/amadeus.ts` — OAuth2 client-credentials flow, bearer-token cache (8min TTL), generic `amadeusFetch` wrapper
- `worker/handlers/flights.ts` — `GET /api/flights?slug=X&token=Y` returns cached or fresh
- `proposal_cache` table: `(key="flights:<token>", value=json, fetched_at)` — DO method `getCachedProposal()` / `setCachedProposal()`
- Cache TTL: 24h (flight prices don't change minute-to-minute for hobby use)
- Cron `scheduled` handler: on poll close → trigger flight fetch for every participant in parallel, store to cache
- Fail gracefully: if Amadeus down or credentials missing, log + return empty list (don't break the email)

**Env vars:**
- `WHENWEGO_AMADEUS_CLIENT_ID` (secret)
- `WHENWEGO_AMADEUS_CLIENT_SECRET` (secret)
- `WHENWEGO_AMADEUS_ENV` — "test" or "production" (test endpoint for free tier)

**Cost math:** 4-person poll = 4 flight calls at close + ~12 calls across reminders = 16/poll. Free tier 2000/month = 125 polls/month before paying.

**Edge cases:**
- Participant's home airport has no direct flights to destination → Amadeus returns 0 results, we show "no direct flights found, search manually on [Google Flights link]"
- Destination is a non-airport (Hallstatt) → fall back to nearest IATA airport from a fuzzy match
- Cached results older than 24h on participant visit → re-fetch synchronously (slow first page load, fast after)

**Acceptance:**
- After close, each participant's email + token page shows their personalised flight list
- Refresh button works, respects 1h rate limit
- Empty/error states render cleanly, never break the page

---

## Phase 6 — Hotel Search (Amadeus)

**Goal:** Once poll closes, surface a shortlist of hotels in the destination for the locked dates.

**User-facing:**
- Shared list (everyone sees same options) — they're rooming together
- Top 5 by `price_per_night * number_of_nights`, with star rating + distance to city center
- Per-hotel: "split N ways = €X/person" math done automatically (N = participant count)
- Organiser dashboard has hotel-choice radio buttons → records chosen hotel in `poll_meta`

**Tech:**
- `worker/handlers/hotels.ts` — `GET /api/hotels?slug=X` (any valid token — participant or organiser)
- Same Amadeus auth flow as Phase 5
- Cache TTL: 24h, single cache key per slug (not per-participant)
- Endpoint chain: `Hotel List` (find hotels in city) → `Hotel Offers Search` (price for dates + 4 guests)

**Edge cases:**
- Destination is a region not a city (Bavaria) → fallback to largest city in region
- 4 guests + only 2-bed rooms available → show with note "may need 2 rooms"
- Prices in non-EUR currency → convert via Amadeus's bundled exchange rate

**Acceptance:**
- Shared hotel shortlist appears in post-close UI + email
- Per-person price split shown
- Organiser can mark "this is the one" — appears as locked choice for everyone

---

## Phase 7 — Activity Suggestions (Claude API)

**Goal:** Once poll closes, surface 8-10 curated things to do in the destination during the locked week.

**User-facing:**
- Shared list with two tiers:
  - "**Happening this week**" — 3-4 time-bound events (concerts, festivals, exhibitions opening)
  - "**Always great**" — 4-5 evergreen highlights (top museums, neighborhoods, food)
- Per-activity: name, type icon (🎵 🎨 🏛️ 🍽️ etc.), brief why (1 sentence), free/paid hint
- Refresh button → re-runs LLM (rate-limited to 1/day per poll)

**Tech:**
- `worker/lib/claude.ts` — raw fetch to `https://api.anthropic.com/v1/messages`, model `claude-3-5-haiku-latest`
- Structured output via `tools` API for guaranteed JSON shape:
  ```
  tools: [{ name: "submit_activities", input_schema: {...} }],
  tool_choice: { type: "tool", name: "submit_activities" }
  ```
- `worker/handlers/activities.ts` — `GET /api/activities?slug=X`
- `proposal_cache` table same pattern as hotels (single key per slug, 7d TTL — activities are slower-moving than flight prices)
- System prompt template: "You're suggesting activities for a group of N people visiting <destination> from <start> to <end>. Return JSON via the submit_activities tool with two arrays: thisWeek (time-bound) and alwaysGreat (evergreen)."

**Env vars:**
- `WHENWEGO_ANTHROPIC_API_KEY` (secret)

**Cost math:** Haiku at ~$0.001/poll (1k input + 2k output tokens). $5 signup credit = 5000 polls.

**Edge cases:**
- Destination too obscure → LLM admits it, shows fewer items + falls back to "use Google Maps to find local food"
- Date range too far in future (>1 year) → "events this far out aren't reliable; check closer to the date"
- LLM hallucinates an event → mitigation: include "only suggest events you're highly confident exist" + ask for source URLs in prompt → manually verify a few before deciding to trust output blanket

**Acceptance:**
- Post-close UI shows curated activities split into two sections
- Refresh works, respects daily rate limit
- LLM failure → graceful fallback message, never breaks page

---

## Phase 8 — Email + iCal Close-Summary

**Goal:** When the poll closes, send each participant a personalised email with: trip confirmation, their flights, shared hotels + activities, calendar add-links, .ics attachment with reminders.

**User-facing:**
- Each participant receives one email at poll close (subject: "🎉 Copenhagen is set — Jul 12-15")
- Email body sections: greeting + dates, their flights, shared hotels, activities, "Add to Calendar" buttons, reminder schedule preview, link back to per-token page
- `.ics` file attached, importable to any calendar app
- Per-button add-to-calendar links: Google Calendar (URL-based), Outlook Web (URL-based), Apple Calendar (.ics download), Yahoo (URL-based)

**Tech:**
- `worker/lib/resend.ts` — port from pay-me-back
- `worker/lib/email-templates.ts` — single function `renderCloseSummaryEmail({poll, participant, flights, hotels, activities, icalUrl})` returns `{ subject, html, text, attachments }`
- HTML email: ~200 lines, table-based layout (still the standard for email clients), pixel-art header banner (same as banner.png but inlined as `<img>` with absolute URL), brand teal accent, mobile-responsive via `<meta>` viewport + simple media queries
- Text fallback for plaintext-only clients
- `worker/lib/ical.ts` — generate `.ics` per RFC 5545: VCALENDAR + VEVENT with VALARMs at -30d, -7d, -1d, -2h
- `worker/handlers/ical.ts` — `GET /api/ical?slug=X&token=Y` returns `.ics` with `Content-Type: text/calendar; charset=utf-8` + `Content-Disposition: attachment; filename="<slug>.ics"`
- Public route `/ical/<slug>.ics` redirects to `/api/ical?slug=<slug>` for shareable add-to-calendar links
- Send on close:
  - `scheduled.ts` after `closeNow()` succeeds, iterates participants
  - For each: render personalised email, `await sendResendEmail({to, subject, html, text, attachments})` via `ctx.waitUntil()`
  - Failures logged but don't block other participants

**Add-to-calendar URL formats:**
- Google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=<title>&dates=<startYYYYMMDD>/<endYYYYMMDD>&details=<desc>&location=<loc>`
- Outlook: `https://outlook.live.com/calendar/0/deeplink/compose?subject=<title>&startdt=<ISO>&enddt=<ISO>&body=<desc>&location=<loc>`
- Apple: download .ics
- Yahoo: `https://calendar.yahoo.com/?v=60&title=<title>&st=<startYYYYMMDDT000000Z>&et=<endYYYYMMDDT000000Z>&desc=<desc>&in_loc=<loc>`

**Env vars:**
- `WHENWEGO_RESEND_API_KEY` (secret)
- `WHENWEGO_RESEND_FROM` — e.g. `"when-we-go <hello@your-domain.com>"`. Fallback `"when-we-go <onboarding@resend.dev>"` (sandbox, only sends to verified recipients).
- `WHENWEGO_SITE_URL` — absolute URL for links inside email (no relative URLs in email — never works)

**Edge cases:**
- Participant has no email in profile → skip silently, log "no email for token X, telegramonly mode"
- Email bounce (invalid address) → Resend webhook (Phase 9 extension; out of scope for first cut)
- .ics attachment too large (>5MB) → impossible at our scale (single event ~3KB)
- Timezone for the .ics → use the poll's destination timezone (look up via destination → tz mapping, fallback Europe/Berlin)
- Reminder VALARMs may show up as duplicate notifications alongside our cron emails — by design, belt-and-braces

**Acceptance:**
- Real test: trigger `POST /api/admin/close` on a fresh poll with 4 participants who all have profiles
- Each receives one email within 60 seconds
- Each .ics imports cleanly into Google Calendar / Apple Calendar
- Add-to-calendar buttons open the correct calendar with prefilled event
- Reminders preview shows next 4 ping times

---

## Phase 9 — Reminder Schedule

**Goal:** Worker cron fires reminder emails at T-30, T-7, T-1, T+1 (days before/after the trip start date).

**User-facing:**
- Participant receives 4 follow-up emails after close-summary:
  - T-30: "Trip in a month — latest flight prices (re-fetched), packing checklist link"
  - T-7: "Trip next week — weather forecast for destination, activity reminders"
  - T-1: "Tomorrow! — hotel address + map, transit to airport, boarding-pass nudge"
  - T+1: "Hope it was great — want to plan another?"
- Each email also includes a link back to per-token page (kept alive post-trip so people can grab their iCal again if needed)

**Tech:**
- `reminders_sent` table in DO: `(token, type, sent_at, status)` — prevents double-sends
- `scheduled.ts` extended:
  - For each poll: skip if not closed
  - Compute `tripStart = first day in overlap.perfect (or .withEffort if perfect empty)`
  - For each reminder type (T-30, T-7, T-1, T+1): if `now` is within ±1h of the trigger window AND `reminders_sent` doesn't have a row for `(token, type)`, send email + insert row
- Email templates for each reminder type in `email-templates.ts`
- T-30 specifically re-fetches Amadeus flights (prices may have changed) — calls `getFlights(force=true)`

**Edge cases:**
- Cron runs hourly but trigger window is ±1h → math: if cron fires at 14:00 UTC, send T-30 email if tripStart is between 30 days ago - 1h and 30 days ago + 1h. Avoids missed sends if cron is briefly down.
- Trip canceled (organiser nukes the poll) → DO deletion clears `reminders_sent` automatically
- User changes email mid-cycle → uses latest email on next reminder send
- Poll has no participant emails → cron skips silently, organiser-Telegram-only

**Acceptance:**
- Manual test: set a poll's `tripStart` to "30 days from now ± 30min", run cron via `wrangler dev --test-scheduled`
- All 4 participants receive T-30 email
- Re-run cron immediately → no duplicates sent
- Manually advance `reminders_sent` table to verify T-7 / T-1 / T+1 each fire correctly

---

## Phase 10 — pay-me-back Integration

**Goal:** One button in organiser dashboard exports a pay-me-back-compatible JSON for splitting the trip costs.

**User-facing:**
- Post-close admin dashboard shows new "Split costs" section
- Lists each participant with editable amount input
- Defaults: hotel cost / N (if hotel chosen in Phase 6) + flight cost from their personalised result (if available)
- "Export to pay-me-back" button generates the JSON, copies to clipboard, opens [pay-me-back template setup guide](https://github.com/Leonardboeker/pay-me-back#quick-start) in new tab

**Tech:**
- `worker/handlers/admin-export-payment.ts` — `GET /api/admin/export-payment?slug=X` returns the pay-me-back JSON structure
- Client-side button → fetches the endpoint → renders the JSON in a `<textarea>` for copy
- Schema match: pay-me-back uses `{ token, name, amount, backstory, characterSlug?, createdAt }` per debtor. We translate: each when-we-go participant becomes a pay-me-back debtor. Backstory = "<destination> trip <dateStart>-<dateEnd>". Token = freshly generated nanoid (don't reuse when-we-go tokens — different security boundary).
- Optional follow-up: if pay-me-back-template is auto-detected (env var `WHENWEGO_PAYMEBACK_REPO_PATH` set to a local checkout), one-button "create new pay-me-back instance with this JSON".

**Edge cases:**
- Participant declined to share their flight cost (privacy) → amount field defaults to 0, organiser fills in manually
- Currency: pay-me-back is EUR-only → if any flight was in another currency, convert via stored exchange rate

**Acceptance:**
- "Export" button produces valid pay-me-back JSON
- JSON pastes cleanly into pay-me-back's `data/debtors.json`
- Trip data flows: when-we-go participants become pay-me-back debtors with sensible defaults

---

## Future (post-Phase-10, not promised)

- **Phase 11 — Booking deep-links** — direct "Book this flight on Lufthansa.com" / "Book this hotel on Booking.com" links with prefilled dates + travelers. Affiliate revenue possible (Travelpayouts / Booking Affiliate Network).
- **Phase 12 — Conversational refinement** — chat-style "show me cheaper flights, what if we leave Tuesday?" via multi-turn LLM. Re-runs proposals. Significant scope expansion; only revisit if Phases 4-10 see real use.

---

## Dependencies between phases (visualisation)

```
1. Foundation
   └── 2. Vote+Close
        ├── 3. Polish (✅ done)
        ├── 4. Profile
        │   ├── 5. Flights ──┐
        │   ├── 6. Hotels ───┤
        │   └── 7. Activities┤
        │                    └── 8. Email + iCal
        │                         └── 9. Reminders
        │                              └── 10. pay-me-back
        └── (parallel) cron infra → reused by 5, 7, 9
```

## Suggested execution order

If building all 7 remaining phases in one go:

1. **Phase 4** (Profile) — required substrate, 1 day, autonomous
2. **Phase 8a** (Email infrastructure only — Resend port + simple text email on close) — 1 day, autonomous after Phase 4
3. **Phase 8b** (iCal generation + add-to-calendar links) — half a day, autonomous
4. **Phase 9** (Reminder cron) — 1 day, autonomous
5. **Phase 5** (Flights) — 2 days, needs Amadeus key from you
6. **Phase 6** (Hotels) — 1 day, reuses Amadeus key
7. **Phase 7** (Activities) — 1 day, needs Anthropic key from you
8. **Phase 8c** (enrich close-summary email with flights/hotels/activities) — half a day, autonomous
9. **Phase 9b** (enrich reminder emails with refreshed flight prices) — half a day, autonomous
10. **Phase 10** (pay-me-back export) — 2 days, autonomous

This ordering lets the email + calendar layer ship first (your explicit ask), with proposals layered on after. If something delays Phase 5/7, you still have email + iCal + reminders.

**Total real-time: ~12 days of focused work** spread across however many weekends. All hosting €0.

### Phase 11: Live-Gruppen-Ansicht im Kalender waehrend offener Abstimmung

**Goal:** Während der offenen Abstimmung im Kalender pro Tag sehen, wer (welche Teilnehmer) kann — Gruppen-Verfügbarkeit live, nicht erst nach Poll-Schluss.
**Requirements**: Server liefert pro-Tag-Aggregat über alle Teilnehmer auch bei offener Poll; Client rendert Gruppen-Indikator pro Tag zusätzlich zur eigenen Stimme; live via bestehendem 30s-Refresh.
**Depends on:** Phasen 1-3 (Kalender, Vote-Persistenz, Close-Logik), Phase 4 (Teilnehmer/Profile)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd:plan-phase 11 to break down)

---

## Status field key

- ✅ done — code shipped, verified, in production
- ⏳ planned — phase scoped, CONTEXT.md ready or pending, not started
- future — vision-level only, not committed

Update this table as phases complete. Sync to `STATE.md`.
