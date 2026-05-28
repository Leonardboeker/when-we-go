# when-we-go — Full Vision

> The complete picture of where the project is going. The MVP (Phases 1-3) shipped a Doodle-shaped date-coordination tool. This document is the "actually useful trip planner" version with proposals, calendar integration, and reminders end-to-end.
>
> **Status of this doc:** vision-level. Per-phase implementation details live in `.planning/phases/NN-<name>/NN-CONTEXT.md` (written just-in-time before each phase starts).

## What it is when it's done

A small group of 3-10 people uses one URL per person to:

1. **Find a date** (Phases 1-3, ✅ shipped) — three-state per-day calendar grid, polling-window auto-close, overlap calc surfaces "the dates that work".
2. **Get a personalised travel package** (Phases 5-7) — once the date is locked, each person automatically receives flight options from their home airport, a shortlist of hotels in the destination, and curated activities for that exact week.
3. **Lock it into their calendar** (Phases 8-9) — close-summary email with one-click "Add to Google Calendar / Apple Calendar / Outlook", plus an `.ics` attachment with device-local reminders baked in.
4. **Get reminded at the right moments** (Phase 9) — Worker cron fires "T-30 days", "T-7 days", "T-1 day", "T+1 day" emails so the trip stays on everyone's radar.
5. **Split the costs** (Phase 10) — one button in the organiser dashboard spawns a [pay-me-back](https://github.com/Leonardboeker/pay-me-back) instance with each participant pre-loaded as a debtor for their share.

That's the whole arc. Nothing more, no native apps, no booking-platform deep integration, no AI concierge that re-plans on every chat turn.

## The user story, end to end

> *Leo wants to go to Copenhagen with his sister, dad, and brother.*

**Day 0 — set up**

Leo runs `npm run gen-poll` (CLI), pastes the resulting JSON into `data/polls.json`, deploys. Each family member gets one URL via WhatsApp:

> *"hey — pick when you can come to Copenhagen. https://when-we-go.app/copenhagen/abc123 — closes in 2 weeks."*

**First visit per participant**

Sister opens her URL on her phone. She sees:
- Pixel greeting "Hey Sister — when can you come to Copenhagen?"
- A days-until-close countdown
- **NEW (Phase 4):** a 30-second onboarding form: "we'll need a few things to suggest flights + send invites later" → email, home airport (autocomplete IATA), optional budget cap, optional interests
- The calendar grid, tap to cycle yes/maybe/no per day

She marks ~10 dates that work, taps once each. Closes the tab.

**Throughout the 2-week polling window**

Each time someone votes for the first time, Leo gets a Telegram ping AND email (Phase 8): *"3 of 4 voted on the Copenhagen poll — last to come is Brother."*

**Day 14 — poll closes (Worker cron, Phase 9)**

1. Worker computes overlap → Jul 12-15 works for all 4
2. Worker fires Amadeus API calls in parallel:
   - 4× flight searches (BCN→CPH, MUC→CPH, CGN→CPH, BER→CPH) for Jul 12-15 ±1 day
   - 1× hotel search in Copenhagen for 3 nights, 4 guests, sorted by per-night price
3. Worker fires Claude API call:
   - "What's happening in Copenhagen during Calendar Week 28, 2026? Plus 5 always-great highlights. Return as structured JSON: name, type, date_range, free/paid, brief_why."
4. Per-participant personalised email goes out via Resend:

```
Subject: 🎉 Copenhagen is set — Jul 12-15

Hey Sister, the dates are locked: July 12-15 (3 nights).

✈️ FLIGHTS for you (from Munich MUC)
- Lufthansa direct €119 (Sat 07:30 → Tue 18:20)
- SAS direct €145 (Sat 12:00 → Tue 09:30)
- EasyJet 1 stop €89 (warning: 6h Amsterdam layover)
[ See all 8 options → ]

🏨 HOTELS we're considering (shared rooms — split 4 ways)
- Hotel Skt Petri ★★★★ €420 total (€105/person)
- Wakeup Copenhagen ★★★ €260 total (€65/person)
- Generator Hostel ★★ €180 total (€45/person)
[ Vote on hotel → ]

🎯 IN COPENHAGEN THIS WEEK
- Roskilde Festival (40min train)
- Tivoli summer concerts
- + 5 evergreens (Nyhavn, Christiania, Louisiana Museum, ...)

🗓️ ADD TO CALENDAR
[ Google ] [ Apple ] [ Outlook ] [ Download .ics ]

We'll ping you again 30 days before, 1 week before, 1 day before.

— when-we-go (this is a tool you and Leo run yourselves)
```

**Behind the scenes: calendar invite (Phase 8 .ics)**

Attached `copenhagen.ics` includes:
- DTSTART: 2026-07-12, DTEND: 2026-07-16 (all-day, 3 nights)
- SUMMARY: "Copenhagen — family trip"
- DESCRIPTION: hotel name, flight info, link back to the per-token URL
- LOCATION: "Copenhagen, Denmark"
- VALARM blocks:
  - 30 days before, email-type
  - 7 days before, display-type
  - 1 day before, audio-type
  - 2 hours before, popup-type

Calendar apps respect these — Sister gets device-local push reminders even if our server is down.

**Day 15-44 — reminder cron fires (Phase 9)**

Each Worker cron tick checks: is anyone T-30, T-7, T-1, T+1 from today?
- T-30: "Trip in 1 month! Have you booked your flight yet? Latest prices: [refresh]" (re-runs Amadeus, includes new prices in case they changed)
- T-7: "Trip next week. Packing list: passport (or ID), weather Cph forecast Y°C. Activities reminder: [link]."
- T-1: "Tomorrow! Have you printed boarding passes? Address: [hotel name + map link]. Train to airport: [transit hint]."
- T+1: "Hope it was great. Want to plan another?"

Tracking: each (poll, participant, reminder_type) has a `sent_at` row in DO so we never double-send.

**Day 100 — trip happened, costs to split (Phase 10, optional)**

Leo's admin dashboard shows a new button: "Split the costs?". One click → opens a pay-me-back JSON template prefilled with:
- The 4 participants (with their token names from the poll)
- A blank "amount" field for each
- The trip name as backstory ("Copenhagen Jul 12-15")

Leo fills in actual amounts (e.g. €145 each for shared hotel), exports the JSON, deploys it to a pay-me-back instance. Done.

## System architecture (post-Phase 10)

```
┌─────────────────────────────────────────────────────────────────┐
│                       data/polls.json                            │
│   {slug, title, destination, dateRange, pollClose,               │
│    organizerToken, participants: [{token, name, ?email,          │
│    ?homeAirport, ?budget, ?interests}]}                         │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
   Astro static build    Cloudflare Worker    Wrangler dev
   /<slug>/<token>/      /api/*               local + secrets
   /<slug>/admin/<t>/    DO per slug          via .dev.vars
   /og/<slug>.png        Scheduled handler
   /ical/<slug>.ics      (cron 0 * * * *)

                    ┌────────────────────┐
                    │  WhenWeGoPollDO    │  SQLite-backed, one per slug
                    │                    │
                    │  votes             │  (token, date, state, updated_at)
                    │  vote_history      │  (token, first_voted_at, last_voted_at, count)
                    │  poll_meta         │  (key, value) — closed_at, overlap_cache, ...
                    │  participant_profile │  NEW Phase 4: (token, email, home_airport, budget, interests_json)
                    │  proposal_cache    │  NEW Phase 5-7: (key=flights|hotels|activities, value=json, fetched_at)
                    │  reminders_sent    │  NEW Phase 9: (token, type=T-30|T-7|T-1|T+1, sent_at)
                    └────────────────────┘

External APIs:
  ┌─────────────────────────────────────────────────────────────┐
  │  Amadeus Self-Service     flight + hotel search (free 2k/mo)│
  │  Anthropic Claude API     activity suggestions (paid, ~$0.01/poll)│
  │  Resend                   transactional email (free 3k/mo)  │
  │  Telegram Bot API         organiser pings (free, unlimited) │
  │  Google Calendar URL      add-to-calendar deep-link (free)  │
  └─────────────────────────────────────────────────────────────┘
```

## API choices — what + why

### Flight search → Amadeus Self-Service API

| Why | Detail |
|---|---|
| Free | 2000 requests/month free tier, no credit card required. A 4-person poll uses 4 requests (one per participant) at close + maybe 12 more for the T-30 / T-7 reminder refreshes. ~16/poll. 125 polls/month before hitting free tier. |
| Real data | Same NDC content airlines like Lufthansa publish to their own sites. Not a screen-scrape. |
| One key, multiple endpoints | `Flight Offers Search`, `Hotel Search`, `Hotel List`, `Points of Interest` all use the same API key. |
| Doc-friendly | OAuth2 client-credentials → bearer token → REST calls. ~30 lines of code in `worker/lib/amadeus.ts`. |
| **Limitation** | Free-tier doesn't include the cheapest LCCs (Ryanair, EasyJet for some routes). For our use case (family trip — Lufthansa/SAS/KLM is realistic) this is fine. |
| **Alternative considered** | Kiwi.com Tequila (more complex auth), Skyscanner Rapid ($10/mo for hobby), Duffel (B2B-only). Amadeus wins on free + ease. |

### Hotel search → Amadeus (same key)

| Why | Detail |
|---|---|
| Same dev experience | One auth flow, two endpoints |
| 700k hotels worldwide | Comparable to Booking.com / Hotels.com inventory |
| **Limitation** | Doesn't include Airbnb/Vrbo. For a family of 4 in Copenhagen, hotels are usually the better option anyway (less coordination than booking a whole apartment). If group needs apartments later → manual fallback or move to Hostfully Channel Manager. |

### Activity suggestions → Claude API

| Why | Detail |
|---|---|
| Quality > structured data | Activities/events are hard to API-fetch reliably. Google Places gives you a generic top-rated list, not "what's specifically happening THIS week". An LLM with structured-output prompting reads multiple sources and curates. |
| Cost | Claude 3.5 Haiku at ~$0.25/M input tokens. A poll-close call sends ~1k tokens prompt, gets ~2k tokens response → ~$0.001/call. Free tier: $5 credit on signup → 5000 polls before paying. |
| Determinism | Use `response_format: json_schema` so we get structured `{ activities: [{name, type, dateRange, paid, why}, ...] }` instead of free-form prose. |
| **Alternative considered** | Google Places + Eventbrite + Foursquare (three integrations, each with their own auth, free tier, rate limits). LLM with structured output is one call, one auth, predictable cost. Could swap in real APIs later if results are too generic. |

### Email → Resend

| Why | Detail |
|---|---|
| Already integrated in sister project pay-me-back | Code can be ported verbatim (`worker/lib/resend.ts`) |
| Free tier | 3000 emails/month, 100/day. Per poll: 1 onboarding email per participant + 1 close-summary per participant + 4 reminders = 6 emails/participant. A 4-person poll uses 24 emails. 125 polls/month before hitting free tier. |
| Sender domain | Either verify your own domain (DNS TXT records) or use the sandbox `onboarding@resend.dev` for testing. For Leo's real Copenhagen poll: verify `noreply@leonardboeker.de` once, set as `WHENWEGO_RESEND_FROM`. |
| Attachments | Native support for `.ics` attachments. Just pass `attachments: [{ filename, content_base64, content_type }]`. |
| **Alternative considered** | SendGrid (more complex setup, smaller free tier), Postmark (paid only), Cloudflare Email Routing (receive-only — can't send). Resend wins. |

### Calendar invite → hand-rolled `.ics` + URL-based add-links

| Why | Detail |
|---|---|
| `.ics` is plain text per RFC 5545 | No library needed — we write `BEGIN:VCALENDAR\n...\nEND:VCALENDAR` directly. ~40 lines in `worker/lib/ical.ts`. |
| URL-based add-links for Google/Outlook | Both have documented URL formats — generate href, user clicks, browser opens their calendar with the event prefilled. No OAuth, no app installation. |
| Apple Calendar | Same `.ics` file works — when delivered via email attachment, iOS auto-detects and offers "Add to Calendar". |
| Reminders baked into `.ics` (`VALARM` blocks) | Calendar app fires local push notifications even if our server goes down. Belt-and-braces with the Worker cron email reminders. |
| **Alternative considered** | Use a calendar SDK like @react-calendar — overkill, ships JS we don't need. |

### Notifications → Telegram (organiser) + Resend (all participants)

| Channel | Audience | Events |
|---|---|---|
| Telegram | Organiser only | First vote per person, poll close summary, errors (Amadeus down) |
| Email (Resend) | All participants (when email collected) | Onboarding "thanks for voting", close-summary with proposals, T-30 reminder, T-7 reminder, T-1 reminder, T+1 follow-up |

Channels are independent — Telegram-only works (current MVP), email-only works (post-Phase 4 when emails collected), both works (default).

## Cost model

For Leo's actual Copenhagen poll (4 participants, 1 trip):

| Service | Free tier | Used | Remaining |
|---|---|---|---|
| Cloudflare Workers + Pages + DO | 100k req/day | ~50 req/day | unlimited essentially |
| Amadeus Self-Service | 2000 req/month | ~16 req | 1984 |
| Resend | 3000 emails/month, 100/day | ~24 emails | 2976 |
| Claude API | $5 signup credit | ~$0.005 (5 polls worth at $0.001) | $4.99 |
| Telegram | unlimited | ~3 pings/day | unlimited |
| **Total / poll** | — | **€0** | — |

If when-we-go gets used by 100 different family groups in a month: still €0. The free tiers are sized for this exact pattern (small groups, infrequent events, not high-frequency).

## What we explicitly DON'T build

Things I will push back on if they come up:

- **Native iOS/Android apps** — every adopter has a web browser. PWA is enough.
- **Account system, login, OAuth** — token URLs are the only identity. Lose your token, lose access. Trade-off accepted.
- **Real-time collaborative editing** — polling-on-focus is good enough for a multi-day decision.
- **Multi-language i18n on day 1** — English MVP, German for Leo's family done by string-table swap. Beyond that — adopters fork + translate.
- **Booking-platform integrations beyond search** — we surface options, user books on Booking.com / airline website themselves. We do not become a payment processor.
- **AI concierge with multi-turn refinement** — "show me cheaper flights, what about Tuesday?" → that's GPT-Travel territory. Out of scope.
- **Group chat / messaging inside the tool** — they have WhatsApp.
- **Public discovery / "find other people going to Copenhagen"** — this is a private-group tool, not a social product.
- **Trip reports / photo album / post-trip social features** — out of scope; they have Instagram.

## What needs Leo's input (vs autonomous build)

| Phase | Manual setup needed from you | Estimated time |
|---|---|---|
| 4 (Profile) | nothing | autonomous |
| 5 (Flights) | sign up at https://developers.amadeus.com (free), copy CLIENT_ID + CLIENT_SECRET, run `npx wrangler secret put WHENWEGO_AMADEUS_*` | 5 min |
| 6 (Hotels) | already done in Phase 5 (same key) | 0 min |
| 7 (Activities) | sign up at https://console.anthropic.com (or reuse existing), copy API key, `npx wrangler secret put WHENWEGO_ANTHROPIC_API_KEY` | 5 min |
| 8 (Email + iCal) | verify your sender domain in https://resend.com (DNS TXT records) OR use sandbox for testing. Copy API key. | 15 min (DNS propagation included) or 2 min (sandbox) |
| 9 (Reminders) | nothing — uses Worker cron already configured | autonomous |
| 10 (pay-me-back) | nothing if you already have pay-me-back set up | autonomous |

**Total real-time-cost to you:** ~25 minutes of dashboard clicking, spread across whenever you want to enable each layer.

## How to read the rest of `.planning/`

- **`PROJECT.md`** — the original pitch, unchanged from MVP days
- **`REQUIREMENTS.md`** — original MVP requirements (Phases 1-3), still accurate for what's built
- **`ROADMAP.md`** — updated to reflect all 12 phases (3 done, 7 planned, 2 future)
- **`STATE.md`** — current status; refreshes each phase
- **`VISION.md`** — this document
- **`phases/<NN>-<name>/`** — per-phase CONTEXT.md (decisions) + PLAN.md (tasks) — written just-in-time before each phase starts

Don't read all the CONTEXT.md files now. Read them when you're about to execute that phase.
