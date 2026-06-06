# State

> Where the project currently stands. Updated by gsd workflows as phases progress.

## Current

- **Status:** All 10 phases shipped. UI redesigned (Stitch "Modern Trip Planner" design system). Aktiv entwickelt.
- **Active phase:** UI Polish + Stitch-Vorlage vollständig implementieren
- **PayLeo:** ABGESCHLOSSEN — nicht mehr anfassen
- **Next step:** Stitch-generierte HTML-Screens als Vorlage für verbleibende UI-Lücken nutzen. WHENWEGO_POLLS_JSON + WHENWEGO_ANTHROPIC_API_KEY in CF Pages setzen.

## Phase status overview

| # | Phase | Status | Doc |
|---|---|---|---|
| 1 | Foundation | ✅ done | `phases/01-foundation/` |
| 2 | Date Polling + Auto-Close | ✅ done | `phases/02-polling-and-close/` |
| 3 | Polish + Public Release | ✅ done | `phases/03-polish/` |
| 4 | Participant Profile | ✅ done | `phases/04-participant-profile/` |
| 5 | Flight Search (Kiwi.com Tequila) | ✅ done | `phases/05-flight-search/` |
| 6 | Hotel Search (mock provider) | ✅ done | `phases/06-hotel-search/` |
| 7 | Activity Suggestions (Claude Haiku) | ✅ done | `phases/07-activity-suggestions/` |
| 8 | Email + iCal Close-Summary | ✅ done | `phases/08-email-and-ical/` |
| 9 | Reminder Schedule | ✅ done | `phases/09-reminder-schedule/` |
| 10 | pay-me-back Integration | ✅ done | `phases/10-paymeback-integration/` |

## API keys needed to activate optional features

| Feature | Secret | Where to get | Without it |
|---|---|---|---|
| Real flights (Phase 5) | `WHENWEGO_KIWI_API_KEY` | [tequila.kiwi.com](https://tequila.kiwi.com/portal/login) — free | Mock flights shown with DEMO banner |
| Activity suggestions (Phase 7) | `WHENWEGO_ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Mock evergreen activities shown |
| Email + reminders (Phase 8/9) | `WHENWEGO_RESEND_API_KEY` + `WHENWEGO_RESEND_FROM` | [resend.com](https://resend.com) — free tier | Telegram-only mode |
| Telegram pings | `WHENWEGO_TELEGRAM_BOT_TOKEN` + `WHENWEGO_TELEGRAM_CHAT_ID` | [@BotFather](https://t.me/BotFather) — free | No notifications |

## Master docs

- [`VISION.md`](./VISION.md) — full picture, user flow end to end, API choices with justification, cost model
- [`ROADMAP.md`](./ROADMAP.md) — all 12 phases, dependencies, suggested execution order
- [`PROJECT.md`](./PROJECT.md) — original pitch
- [`REQUIREMENTS.md`](./REQUIREMENTS.md) — MVP requirements (Phases 1-3 covered)

## Recent activity log

- 2026-06-06 — Phase 11 hinzugefügt + gebaut: Live-Gruppen-Ansicht im Kalender (Punkte pro Tag = andere Teilnehmer, Namen beim Antippen, live via 30s-Refresh). Server: `groupVotes` in `poll.ts`. Client: `renderGroupVotes`/`groupSummaryFor` in `[token].astro` + Dot-CSS in `CalendarGrid.astro`.
- 2026-06-06 — Live-Fixes: neuer Build deployed (CF Pages war nicht git-verbunden), German+DM-Sans (Monospace raus), 404 modernisiert, Kalender-first (Profil-Gate entfernt), kopenhagen-2026 Worker-Secret gesetzt.

- 2026-05-28 — Project initialised. MVP scope: date polling only.
- 2026-05-28 — Real driver: Leo + sister + father + brother → Copenhagen trip.
- 2026-05-28 — Phase 1 (Foundation) shipped.
- 2026-05-29 — Phase 2 (Vote Persistence + Auto-Close) shipped. 14/14 smoke green.
- 2026-05-29 — Phase 3 (Polish + Public Release) shipped. Demo live at when-we-go-demo.pages.dev.
- 2026-05-29 — Vision expanded to full trip planner (Phases 4-10 scoped).
- 2026-05-29 — Phases 4-10 all shipped. Full trip planner complete.
- 2026-05-29 — Phase 7 (Activity Suggestions, Claude Haiku) committed. Provider-abstracted with mock fallback.
- 2026-05-29 — Kiwi.com Tequila real flight provider (KiwiFlightProvider) added to Phase 5.
