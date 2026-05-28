# Phase 1 Plan — Foundation

> Concrete task breakdown for delivering Phase 1. Each task is atomic-commit-sized.
> Dependencies use `→` notation. Acceptance criteria below.

## Tasks

### T-01 — Bootstrap project skeleton
**Files:** `package.json`, `astro.config.mjs`, `tsconfig.json`, `.nvmrc`, `.gitignore` (extended), `public/fonts/Inter-ExtraBold.ttf`, `public/fonts/PressStart2P-Regular.woff2`

**Steps:**
1. Copy `package.json` from `D:\dev\pay-me-back-template`, strip Pay-Me-Back-specific deps (`sepa-payment-qr-code`), rename package to `when-we-go`, blank out scripts list (we'll add them back as we wire things up)
2. Required deps: `astro@^6.3.8`, `@astrojs/tailwindcss` wait — that's deprecated → `@tailwindcss/vite` + `tailwindcss@^4.3.0`, `typescript@^5.6`, `nanoid@^5.1`, `qrcode@^1.5` (for QR-in-future, harmless to install now), `zod@^3.25`
3. Dev deps: `@types/node`, `pngjs`, `prettier`, `prettier-plugin-astro`, `tsx`, `wrangler@^4.95`, `satori@^0.26`, `@resvg/resvg-js` (for OG images Phase 3)
4. Copy `astro.config.mjs` (with `site:` from `PUBLIC_SITE_URL`), `tsconfig.json`, `.nvmrc`, fonts dir wholesale
5. Run `npm install` from `D:\dev\when-we-go`

**Done when:** `npm run` (with no args) lists available scripts without erroring; node_modules/ populated.

---

### T-02 — Port aesthetic foundation
**Depends on:** T-01

**Files:**
- `src/styles/global.css` (copy from pay-me-back, swap `--color-primary` from rust to teal)
- `src/layouts/BaseLayout.astro` (adapt: change `REPO_URL`, env var name, ADD sibling-cross-link block)
- `src/components/CopyButton.astro` (wholesale copy)
- `src/types/shims.d.ts` (wholesale copy)
- `public/favicon.svg` (copy; could regenerate later)
- `public/_headers` (wholesale copy)

**Steps:**
1. Copy `src/styles/global.css` → in the palette section, change `--color-primary` from the rust hex to a warm-teal hex (e.g. `#2c8c8c` or similar). Keep all other tokens.
2. Copy `BaseLayout.astro`. Edit:
   - `REPO_URL` → `https://github.com/Leonardboeker/when-we-go`
   - Demo-mode env var: `PAYLEO_DEMO_MODE` → `WHENWEGO_DEMO_MODE`
   - Demo-mode body copy: "Every name, IBAN, payment link is FAKE" → "This is a demo poll. Votes don't persist anywhere and no real trip is being planned."
   - Built-with footer text: "Built with pay-me-back" → "Built with when-we-go"
   - **ADD** below the Built-with footer a sibling-cross-link strip: "💸 Need to split costs after the trip? → pay-me-back" with link to https://github.com/Leonardboeker/pay-me-back
3. Copy `CopyButton.astro`, `shims.d.ts`, `favicon.svg`, `_headers` as-is.
4. Build (`npm run build` once we have a page) verifies CSS compiles.

**Done when:** `BaseLayout` renders without error; demo banner appears when `WHENWEGO_DEMO_MODE=true`; built-with footer + sibling link visible.

---

### T-03 — Polls schema + token model
**Depends on:** T-01

**Files:**
- `src/data/polls.ts` (typed import + Poll type)
- `data/polls.example.json` (Copenhagen example with 4 placeholder participants)
- `scripts/prebuild-polls.mjs` (materialise polls.json from WHENWEGO_POLLS_JSON env var, validate shape)
- `scripts/gen-poll.mjs` (CLI: generate organiser token + N participant tokens, output ready-to-paste JSON)

**Steps:**
1. Write `src/data/polls.ts`:
   ```ts
   import raw from '../../data/polls.json';
   export type Participant = { token: string; name: string };
   export type Poll = {
     slug: string;
     title: string;
     destination?: string;
     dateRangeStart: string;
     dateRangeEnd: string;
     pollCloseAt: string;
     organizerToken: string;
     participants: Participant[];
     createdAt: string;
   };
   export const polls: Poll[] = raw as Poll[];
   ```
2. Write `data/polls.example.json` — one Copenhagen example:
   ```json
   [{
     "slug": "copenhagen-2026",
     "title": "Copenhagen — family trip",
     "destination": "Copenhagen, Denmark",
     "dateRangeStart": "2026-06-01",
     "dateRangeEnd": "2026-09-30",
     "pollCloseAt": "2026-06-14T23:59:59+02:00",
     "organizerToken": "EXAMPLE_ORG_TOKEN_REPLACE",
     "participants": [
       { "token": "EXAMPLE_TOKEN_LEO_REPLACE", "name": "Leo" },
       { "token": "EXAMPLE_TOKEN_SISTER_REPLACE", "name": "Sister" },
       { "token": "EXAMPLE_TOKEN_DAD_REPLACE", "name": "Dad" },
       { "token": "EXAMPLE_TOKEN_BROTHER_REPLACE", "name": "Brother" }
     ],
     "createdAt": "2026-05-28T00:00:00Z"
   }]
   ```
3. Write `scripts/prebuild-polls.mjs` — mirrors pay-me-back's prebuild logic:
   - If `data/polls.json` exists → use it
   - Else read `WHENWEGO_POLLS_JSON` env var → parse → write to `data/polls.json`
   - Validate: each poll has all required fields + slug not in reserved list + dates parse + organizerToken != any participant token + slugs unique across polls + tokens unique across all polls
4. Write `scripts/gen-poll.mjs`:
   - `--slug X --title Y --start ISO --end ISO --close ISO --participants "Alice,Bob,Carol"`
   - Generates organizer token (nanoid 22) + one token per participant (nanoid 16)
   - Prints the JSON object ready to paste into polls.json (or append)
5. Add to package.json scripts: `prebuild`, `gen-poll`
6. Manual smoke: `WHENWEGO_POLLS_JSON='[...]' node scripts/prebuild-polls.mjs` writes correct file; `node scripts/gen-poll.mjs --slug test --title Test --start 2026-06-01 --end 2026-06-30 --close 2026-05-30T23:59:59+02:00 --participants "Alice,Bob"` prints valid JSON.

**Done when:** schema docs + helpers exist; both scripts run cleanly with sample input; types compile.

---

### T-04 — Per-token participant page (static, visual-only)
**Depends on:** T-02, T-03

**Files:**
- `src/pages/[slug]/[token].astro`
- `src/components/CalendarGrid.astro` (visual-only — renders the grid, no interactivity in Phase 1)
- `src/components/PollHeader.astro` (greeting + days-until-close countdown)
- `src/lib/calendar.ts` (pure helpers: enumerate days in range, group by week/month, is-weekend)

**Steps:**
1. `getStaticPaths` enumerates `polls × participants` → `params: { slug, token }`. Reserved slugs (admin, api, etc.) filtered out at config-load time (in prebuild-polls.mjs).
2. Page reads its poll + participant from props, renders:
   - `PollHeader`: "Hey ${name} — when can you come to ${destination}?"
   - Countdown to `pollCloseAt`
   - `CalendarGrid` with all days in `dateRangeStart..dateRangeEnd`, all cells `unset` visually
   - Notice: "Phase 1 preview — saving votes coming in Phase 2"
3. `CalendarGrid` — pure Astro, no interactivity yet:
   - Group days into weeks (Mon-first or Sun-first? Use Mon-first — Europe)
   - Render month-divider rows
   - Mark today + weekends
   - Cells are `<button>` elements with `disabled` attribute (so structure is in place for Phase 2 JS to wire up)
4. `src/lib/calendar.ts`:
   - `enumerateDays(start: string, end: string): string[]`
   - `groupByWeek(days: string[]): { weekStart: string; days: (string|null)[] }[]` (null = padding to Monday)
   - `isWeekend(date: string): boolean`
   - `monthHeader(date: string): string` (e.g. "June 2026")

**Done when:** browsing to `/<slug>/<token>/` renders greeting + countdown + full date-range grid; weekends visually distinct; today marked; no console errors.

---

### T-05 — Organiser dashboard page (static skeleton)
**Depends on:** T-04

**Files:** `src/pages/[slug]/admin/[token].astro`

**Steps:**
1. `getStaticPaths` enumerates `polls × [organizerToken]` (one path per poll using organizerToken as the URL token)
2. Page renders:
   - Poll title + destination + date range + close timestamp
   - Participants table: name + "no votes yet" placeholder (Phase 2 wires up the real vote API)
   - Empty "Best dates" panel (Phase 2 fills it)
   - "Refresh" button (no-op in Phase 1)
3. Same noindex/noreferrer headers as pay-me-back's admin (via BaseLayout)

**Done when:** `/<slug>/admin/<organizerToken>/` renders a complete dashboard skeleton; fake/wrong organiser tokens 404.

---

### T-06 — Landing + 404
**Depends on:** T-02

**Files:** `src/pages/index.astro`, `src/pages/404.astro`

**Steps:** Both pages = thin shells, mirror pay-me-back's "wrong door" pattern. Index says "If you got a link, follow that. If you're here looking for the source, see GitHub." 404 says "Nothing here."

**Done when:** `/` and any non-existent path render correctly.

---

### T-07 — Build verification + isolation test
**Depends on:** T-04, T-05, T-06

**Files:** `scripts/verify-isolation.mjs` (adapted from pay-me-back)

**Steps:**
1. After `npm run build`, scan each generated HTML in `dist/`
2. For each per-token page, verify it contains ONLY its own participant's name + token, NOT any other participant's data from any other poll
3. For each organizer page, verify it contains all of its poll's participants (by name) and NO data from other polls
4. Hard-fail on any leak

**Done when:** `npm run verify-isolation` passes; cross-poll isolation guaranteed; ready for Phase 2.

---

### T-08 — README + .env.example + Wrangler stub
**Depends on:** T-07

**Files:** `README.md`, `.env.example`, `wrangler.toml`, `worker/index.ts` (stub), `worker/durable-object.ts` (stub)

**Steps:**
1. README: similar structure to pay-me-back but trimmed for "Phase 1 status: foundation only, full MVP coming in Phase 2". Link to ROADMAP.
2. `.env.example` documents all `WHENWEGO_*` env vars (POLLS_JSON, ORGANIZER_DEFAULTS, etc.)
3. `wrangler.toml` — empty `WhenWeGoPollDO` binding scaffolded, route placeholder, deadline var
4. `worker/index.ts` — stub returning `{ phase: 1, ready: false }` on `/api/*`
5. `worker/durable-object.ts` — class skeleton with empty methods (the SQLite schema we'll fill in Phase 2)

**Done when:** template builds + ships clean; adopter could clone today and get a working static site (no vote functionality).

---

### T-09 — git init + private GitHub repo + first commit
**Depends on:** T-08

**Steps:**
1. `git init -b main` in `D:\dev\when-we-go`
2. `git add -A && git commit -m "Phase 1: foundation"`
3. `gh repo create when-we-go --private --source=. --description "..."` (private until MVP works)
4. `git push -u origin main`
5. Add topics: `astro`, `cloudflare-pages`, `cloudflare-workers`, `durable-objects`, `tailwindcss`, `date-coordination`, `trip-planning`, `template`

**Done when:** `https://github.com/Leonardboeker/when-we-go` exists, private, first commit visible.

---

## Acceptance criteria for Phase 1 done

All of:
1. `npm install && npm run build` succeeds on a fresh clone
2. Browsing the built site shows the Copenhagen example poll's 4 participant pages + 1 admin page
3. `npm run verify-isolation` passes
4. No PII in committed files (real `data/polls.json` is gitignored; only `polls.example.json` lives in repo)
5. README sufficient for someone to understand what Phase 1 does + does not include
6. GitHub repo exists, private, first commit pushed
7. Demo banner toggles correctly via `WHENWEGO_DEMO_MODE=true`
8. Built-with footer + sibling-cross-link to pay-me-back render on every page

## What Phase 1 explicitly does NOT include

- ❌ Worker/DO actually persisting anything
- ❌ Date-grid interactivity (clicks do nothing in Phase 1)
- ❌ Telegram pings
- ❌ Overlap calculation
- ❌ Auto-close cron
- ❌ Demo deployment to pages.dev
- ❌ Public GitHub repo (stays private until Phase 3 polish)
- ❌ Per-poll OG images (Phase 3)

All of those are Phase 2 / Phase 3 — see ROADMAP.md.

## Order of execution

Linear: T-01 → T-02 → T-03 → T-04 → T-05 → T-06 → T-07 → T-08 → T-09.

T-03 + T-02 could run in parallel after T-01, but linear is fine — Phase 1 should finish in one or two sittings.
