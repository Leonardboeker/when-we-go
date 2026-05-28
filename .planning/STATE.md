# State

> Where the project currently stands. Updated by gsd workflows as phases progress.

## Current

- **Status:** MVP shipped (Phases 1-3). Phases 4-10 fully scoped + per-phase CONTEXT.md ready. Awaiting decision on which to build next.
- **Active phase:** none
- **Next step:** pick a phase to start (recommended order: 4 → 8 → 9 → 5 → 6 → 7 → 10, see `ROADMAP.md`)

## Phase status overview

| # | Phase | Status | Doc |
|---|---|---|---|
| 1 | Foundation | ✅ done | `phases/01-foundation/` |
| 2 | Date Polling + Auto-Close | ✅ done | `phases/02-polling-and-close/` |
| 3 | Polish + Public Release | ✅ done | `phases/03-polish/` |
| 4 | Participant Profile | 📋 CONTEXT ready | `phases/04-participant-profile/04-CONTEXT.md` |
| 5 | Flight Search (Amadeus) | 📋 CONTEXT ready | `phases/05-flight-search/05-CONTEXT.md` |
| 6 | Hotel Search (Amadeus) | 📋 CONTEXT ready | `phases/06-hotel-search/06-CONTEXT.md` |
| 7 | Activity Suggestions (Claude) | 📋 CONTEXT ready | `phases/07-activity-suggestions/07-CONTEXT.md` |
| 8 | Email + iCal Close-Summary | 📋 CONTEXT ready | `phases/08-email-and-ical/08-CONTEXT.md` |
| 9 | Reminder Schedule | 📋 CONTEXT ready | `phases/09-reminder-schedule/09-CONTEXT.md` |
| 10 | pay-me-back Integration | 📋 CONTEXT ready | `phases/10-paymeback-integration/10-CONTEXT.md` |

`📋 CONTEXT ready` = decisions locked, ready for `/gsd:plan-phase NN` → `/gsd:execute-phase NN` to build it.

## Master docs

- [`VISION.md`](./VISION.md) — full picture, user flow end to end, API choices with justification, cost model
- [`ROADMAP.md`](./ROADMAP.md) — all 12 phases, dependencies, suggested execution order
- [`PROJECT.md`](./PROJECT.md) — original pitch
- [`REQUIREMENTS.md`](./REQUIREMENTS.md) — MVP requirements (Phases 1-3 covered)

## What's needed from Leo to start each phase

| Phase | Manual setup | Time |
|---|---|---|
| 4 | nothing | autonomous |
| 5 | Amadeus dev account (free) + 2 secrets | 5 min |
| 6 | nothing (reuses Phase 5 key) | autonomous |
| 7 | Anthropic API key + 1 secret | 5 min |
| 8 | Resend account + verified sender domain (or use sandbox) + 2 secrets | 15 min (or 2 min sandbox) |
| 9 | nothing | autonomous |
| 10 | nothing | autonomous |

## Recent activity log

- 2026-05-28 — Project initialised. MVP scope: date polling only.
- 2026-05-28 — Real driver: Leo + sister + father + brother → Copenhagen trip.
- 2026-05-28 — Phase 1 (Foundation) shipped.
- 2026-05-29 — Phase 2 (Vote Persistence + Auto-Close) shipped. 14/14 smoke green.
- 2026-05-29 — Phase 3 (Polish + Public Release) shipped. Demo live at when-we-go-demo.pages.dev, repo flipped public + template.
- 2026-05-29 — **Vision expanded**: scope extended from MVP date-polling to full trip planner with personalised proposals (flights/hotels/activities) + email notifications + iCal calendar invites + reminder schedule + pay-me-back integration. `VISION.md` written, `ROADMAP.md` expanded from 3 to 12 phases, per-phase CONTEXT.md drafted for Phases 4-10. No code changes yet — planning artifacts only.

## What to do next

Pick one:

**Option A — most useful path** (1.5 weeks of work spread out):
1. Phase 4 (Profile) — 1 day, autonomous
2. Phase 8 (Email + iCal) — 2 days, needs Resend key
3. Phase 9 (Reminders) — 1 day, autonomous
4. Phase 5 (Flights) — 2 days, needs Amadeus key
5. Phase 6 (Hotels) — 1 day, reuses Amadeus
6. Phase 7 (Activities) — 1 day, needs Anthropic key
7. Phase 10 (pay-me-back export) — 2 days, autonomous

After Phase 9: real Copenhagen trip can launch — dates lock, calendar invites + reminders go out. Phases 5-7 layer in proposals; not blocking.

**Option B — start with the email piece (your explicit ask)**:
- Skip 4-7 for now
- Build Phase 8 with empty flights/hotels/activities (close-summary still works — dates + calendar links + reminders preview)
- Then Phase 9 reminders
- Defer 5/6/7 until you decide if they're worth the API setup

**Option C — just Phase 4 to start**:
- Sets up the substrate (email + airport)
- Decide what to do next based on how that lands

Tell me which option to start with.
