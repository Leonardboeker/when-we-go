# State

> Where the project currently stands. Updated by gsd workflows as phases progress.

## Current

- **Status:** Phase 2 (Date Polling + Auto-Close) complete — full MVP shipped (static + Worker + DO + cron + Telegram)
- **Active phase:** none
- **Next step:** Phase 3 (Polish + Demo + Public Release) OR deploy the Worker for real to start using it on the Copenhagen poll

## Phase status

| Phase | Status | Note |
|---|---|---|
| 1 — Foundation | ✅ done | Astro project, token model, per-token + admin pages render, isolation verified |
| 2 — Date Polling + Auto-Close | ✅ done | Worker + DO + 5 API endpoints + hourly cron + Telegram pipeline + interactive calendar grid + admin dashboard wired |
| 3 — Polish + Documentation | not started | demo deployment, OG previews, README polish, flip public |

## Recent activity log

- 2026-05-28 — Project initialised. PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md written. MVP scope locked: date polling only.
- 2026-05-28 — Real driver identified: Leo + sister + father + brother → Copenhagen trip in summer 2026.
- 2026-05-28 — Phase 1 CONTEXT.md + PLAN.md written. 9 atomic tasks (T-01..T-09).
- 2026-05-28 — Phase 1 T-01..T-08 executed via dispatched subagent. Build green (7 static pages), cross-poll isolation verified, demo banner toggles via `WHENWEGO_DEMO_MODE`, sibling cross-link to pay-me-back renders on every page.
- 2026-05-28 — Phase 1 T-09 done (git init + private GitHub repo `Leonardboeker/when-we-go` + first commit pushed).
- 2026-05-29 — Phase 2 CONTEXT.md + PLAN.md written. 16 atomic tasks (T-01..T-16). Decisions locked: 1 DO per poll, 3-table SQLite schema, 5 API endpoints, hourly cron, bulk-replace vote semantics, tap-cycle calendar UI.
- 2026-05-29 — Phase 2 T-01..T-15 executed via dispatched subagent. Worker compiles clean (`wrangler deploy --dry-run` 147 KiB), overlap calc has 8 passing unit tests (≥ 6 required), build still produces 7 static pages with isolation verified.
- 2026-05-29 — Env var inconsistency fixed: subagent had named the secret `POLLS_JSON`; renamed to `WHENWEGO_POLLS_JSON` across `worker/durable-object.ts`, `worker/lib/polls-config.ts`, `worker/scheduled.ts`, `wrangler.toml`, `.dev.vars` so it matches Phase 1's prebuild script + `.env.example` convention.
- 2026-05-29 — End-to-end smoke test green against fresh `wrangler dev` instance: 14/14 checks (health, valid vote, wrong token 401, missing slug 404, malformed body 400, out-of-range date 400, GET /api/poll, admin auth, force close, 410 after close, post-close overlap rendered, idempotent close).
