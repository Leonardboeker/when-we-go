# State

> Where the project currently stands. Updated by gsd workflows as phases progress.

## Current

- **Status:** Phase 3 (Polish + Public Release) complete — repo is public, demo is live, template marker on
- **Active phase:** none
- **Next step:** Leo runs the real Copenhagen poll for his family (`npm run gen-poll`, edit `data/polls.json`, deploy)

## Phase status

| Phase | Status | Note |
|---|---|---|
| 1 — Foundation | ✅ done | Astro project, token model, per-token + admin pages, isolation verified |
| 2 — Date Polling + Auto-Close | ✅ done | Worker + DO + 5 API endpoints + hourly cron + Telegram pipeline + interactive calendar grid + admin dashboard |
| 3 — Polish + Documentation | ✅ done | Banner, polished README, OG images, demo at when-we-go-demo.pages.dev, repo flipped public + marked as template |

## Recent activity log

- 2026-05-28 — Project initialised. PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md written.
- 2026-05-28 — Real driver: Leo + sister + father + brother → Copenhagen trip in summer 2026.
- 2026-05-28 — Phase 1 shipped via subagent: 7 static pages, cross-poll isolation verified, sibling cross-link to pay-me-back.
- 2026-05-29 — Phase 2 shipped via subagent: Worker, DO, 5 API endpoints, hourly cron, Telegram pipeline, interactive calendar grid, admin dashboard. 14/14 smoke tests green against `wrangler dev`. Env var inconsistency (`POLLS_JSON` → `WHENWEGO_POLLS_JSON`) caught + fixed.
- 2026-05-29 — Phase 3 shipped: nano-banana banner (`public/banner.png`), polished 449-line README mirroring pay-me-back's structure, per-poll OG image generator (`src/pages/og/[slug].png.ts`, Satori + Resvg), deployed demo to https://when-we-go-demo.pages.dev with `WHENWEGO_DEMO_MODE=true` yellow banner. Repo flipped public + marked as GitHub Template. 10 topics added. All 5 deployed-demo endpoints (root, participant, admin, OG image, banner) verified 200.

## What's not done (out of MVP scope, future work)

- AI trip suggestions (Cloudflare AI Workers binding — free tier)
- Booking platform deep-links (Booking.com, Airbnb search for locked dates)
- pay-me-back integration (closed-poll button → spawn pay-me-back instance pre-populated with participants)
- Drag-to-range selection in calendar grid
- Multi-poll dashboards (only worth it if Leo runs > 1 poll)
- Real-time vote updates via SSE (current polling-on-focus is good enough)
- Resend email fallback for adopters without Telegram

## For Leo's actual Copenhagen poll

When ready to run the real thing:

1. `cd D:\dev\when-we-go`
2. `npm run gen-poll -- --slug copenhagen --title "Copenhagen — family" --destination "Copenhagen, Denmark" --start 2026-06-15 --end 2026-09-15 --close 2026-06-08T23:59:59+02:00 --participants "Leo,Lea,Papa,Bro"`
3. Paste the printed JSON into `data/polls.json` (local only — gitignored).
4. Set the same JSON as `WHENWEGO_POLLS_JSON` secret in CF Pages dashboard + via `npx wrangler secret put WHENWEGO_POLLS_JSON`.
5. Optional: `npx wrangler secret put WHENWEGO_TELEGRAM_BOT_TOKEN` + `WHENWEGO_TELEGRAM_CHAT_ID` for pings.
6. `npx wrangler deploy` (Worker) + `npx wrangler pages deploy dist --project-name=when-we-go` (separate from the demo project).
