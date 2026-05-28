# when-we-go

> Doodle-shaped microsite for figuring out when a small group of friends or family can actually go on a trip together.

🚧 **Status: Phase 1 (Foundation) complete — static build only, no vote persistence yet.** See [`.planning/ROADMAP.md`](./.planning/ROADMAP.md) for the build plan.

## What it is (eventually)

A small group (3-8 people) wants to go somewhere together. Each person gets a personal URL with a tappable calendar. They mark "yes / maybe / no" for each day in the trip window. After the polling window closes, the system surfaces the dates that work for everyone, and the organiser gets a Telegram ping with the verdict.

No accounts. Per-token URLs (same shape as [pay-me-back](https://github.com/Leonardboeker/pay-me-back) — see [Sibling project](#sibling-project) below). Self-hosted on Cloudflare free tier. €0/month.

## Why

Real driver: a family-of-4 Copenhagen trip needs to find a date that works for everyone. Doodle works but feels clinical; Google Calendar's "find a time" only works inside one workspace; WhatsApp polls don't aggregate well. This is the smallest possible solution that fits the use case.

See [`.planning/PROJECT.md`](./.planning/PROJECT.md) for the full pitch.

## Sibling project

Part of a small "friend-sized internet" series. Sister tool: **[pay-me-back](https://github.com/Leonardboeker/pay-me-back)** — same group-of-friends shape, same Astro + Cloudflare stack, same pixel-art aesthetic.

- `when-we-go` figures out **when** the group goes.
- `pay-me-back` figures out **who pays what** once they're back (or before).

Both tools intentionally have the same vibe so the two can compose: in a later phase, when a `when-we-go` poll closes with a confirmed date + cost estimate, it can spawn a `pay-me-back` instance preloaded with each participant as a debtor. Not built yet — that's the natural Phase 4+.

## Stack (planned, locked in Phase 1)

- Astro 6 (static)
- Tailwind v4
- Cloudflare Pages + Worker + Durable Object (SQLite)
- Telegram Bot for notifications
- MIT licensed

Same shape as pay-me-back — the learnings transfer 1:1.

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| 1 | Foundation — Astro project, token model, per-participant page, static build | ✅ done |
| 2 | Date Polling + Auto-Close — Worker, DO, vote API, scheduled handler, overlap calc, Telegram pings | ⏳ next |
| 3 | Polish + Documentation — README, demo, OG images, public release | ⏳ planned |

Future (post-MVP, not promised): AI activity suggestions, booking platform deep-links, pay-me-back integration. See [`.planning/ROADMAP.md`](./.planning/ROADMAP.md).

## Local dev

```bash
nvm use                    # picks up .nvmrc (Node 22.16)
npm install
cp data/polls.example.json data/polls.json   # seed your own poll, OR run `npm run gen-poll -- --help`
PUBLIC_SITE_URL=http://localhost:4321 npm run build
npm run preview
```

To verify cross-poll isolation in the built `dist/`:

```bash
npm run verify-isolation
```

To render the loud "DEMO POLL" banner at the top of every page (for showcase deployments):

```bash
WHENWEGO_DEMO_MODE=true npm run build
```

## What Phase 1 includes

- Astro 6 static build + Tailwind v4 design tokens
- Per-participant page `/<slug>/<token>/` with greeting + countdown + visual-only calendar grid
- Organiser dashboard skeleton `/<slug>/admin/<organizerToken>/`
- `npm run gen-poll` CLI for generating new polls with secure tokens
- Cross-poll + cross-participant isolation enforced at build (`verify-isolation.mjs`)
- Worker + Durable Object scaffolding (stubs only — Phase 2 fills in)

## What Phase 1 does NOT include

- Vote persistence (the calendar grid is visual-only)
- Worker API endpoints (the stub in `worker/index.ts` returns `{ phase: 1, ready: false }`)
- Telegram notifications
- Auto-close cron
- Per-poll OG images

## License

MIT — same as [pay-me-back](https://github.com/Leonardboeker/pay-me-back).
