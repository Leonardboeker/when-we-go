# Phase 1 Context — Foundation

> Locked-in implementation choices for Phase 1. Downstream `gsd-planner` + `gsd-executor` work from these.
> Any decision marked `[default]` was taken without explicit user input but is reversible — flag in code comments if you disagree on first execution.

## Architecture decisions

### A-01 — Stack: mirror pay-me-back 1:1 `[default]`
Use the exact same stack as the sibling project so learnings + components port over with zero ceremony:
- **Astro 6** (latest stable), `output: 'static'`, prerender every route
- **Tailwind v4** via `@tailwindcss/vite` plugin (CSS-first config)
- **TypeScript** strict mode
- **Cloudflare Pages** for hosting
- **Cloudflare Worker + Durable Object (SQLite)** for poll state (Phase 2)
- **nanoid** for tokens
- **Wrangler** 4.x

No deviations. If something feels different, ask before changing.

### A-02 — Repo: separate, public-from-day-one
- Repo: `Leonardboeker/when-we-go` (NEW, separate from pay-me-back)
- Visibility at init: **private**. Flip to public after Phase 3 (Polish) when the README is real.
- License: MIT (same as pay-me-back)

### A-03 — Routing structure
Routes are namespaced by poll slug because the template should support multiple polls per deployment (unlike pay-me-back which is single-instance per Leo). The slug is human-readable, the token is random.

| Route | Purpose | Who |
|---|---|---|
| `/` | Landing — "wrong door" same shape as pay-me-back's index | Anyone |
| `/<slug>/<token>/` | Participant vote page | Person with the token |
| `/<slug>/admin/<token>/` | Organiser dashboard | Person with organiser token |
| `/404` | Standard 404 | — |

Reserved slug values: `admin`, `api`, `404`, `favicon`, `robots`, `sitemap`, `og`.

## Data model

### D-01 — Poll JSON schema
A poll is the unit of coordination. Multiple polls can live in one deployment.

```typescript
type Poll = {
  slug: string;              // URL-safe, e.g. "copenhagen-2026". Reserved values forbidden.
  title: string;             // Human-readable, e.g. "Copenhagen — family of 4"
  destination?: string;      // Optional, e.g. "Copenhagen, Denmark"
  dateRangeStart: string;    // ISO date, inclusive. e.g. "2026-06-01"
  dateRangeEnd: string;      // ISO date, inclusive. e.g. "2026-09-30"
  pollCloseAt: string;       // ISO timestamp with TZ. e.g. "2026-06-14T23:59:59+02:00"
  organizerToken: string;    // nanoid(22) — sees aggregates
  participants: Array<{
    token: string;           // nanoid(16) — unique per participant per poll
    name: string;            // First name only typical, but any string
  }>;
  createdAt: string;         // ISO timestamp
};
```

### D-02 — Vote state (Phase 2 — sketched here for forward compat)
Each participant's votes live in the Durable Object as `Map<date_iso, 'yes' | 'maybe' | 'no'>`. Dates not in the map default to `'no'`. The DO is keyed by `slug` (one DO per poll), votes are keyed by `token`.

### D-03 — Token format
Same as pay-me-back: `nanoid(16)` for participants, `nanoid(22)` for organiser tokens. URL-safe alphabet by default. Generated via the `nanoid` package.

### D-04 — Date semantics
- All dates stored as ISO `YYYY-MM-DD` (no time-of-day for MVP — full-day granularity per NF in REQUIREMENTS)
- All timestamps (poll close, votes) ISO with explicit TZ offset
- Default TZ for display: Europe/Berlin (matches pay-me-back convention)

## Visual design

### V-01 — Aesthetic: shared "friend-sized internet" look `[default]`
Same warm-sunset Barcelona Pixel Dawn palette as pay-me-back. Same fonts (Press Start 2P / JetBrains Mono / Syne / Space Mono). Same pixel-border component patterns. The two tools should feel like a matched pair — that's the brand for the broader series.

**One differentiator:** primary accent shifts from `rust` (pay-me-back) to `teal-blue` for when-we-go. Same warmth + same crunchy pixel feel, different "this tool is about going somewhere" vibe. Both palettes coexist as CSS custom properties; we just swap `--color-primary` in `global.css`.

If V-01 turns out wrong on first sight, easy revert: change `--color-primary` back to the rust value.

### V-02 — Calendar grid UI
**One Astro island, vanilla JS, no framework hydration.** Same philosophy as pay-me-back: every "interactive" piece is a hand-written `<script>` block, no React/Vue/Svelte runtime.

**Mechanic (mobile-first):**
- Tap day cell → cycles `unset → yes → maybe → no → unset` (one tap per state)
- Long-press (≥ 500ms) on a cell → opens a 3-button selector overlay (`Yes / Maybe / No`) for explicit choice
- Cell color encodes state: `yes` = primary, `maybe` = surface-container with stripes, `no` = surface-container-lowest, `unset` = blank

**Layout:**
- Weeks as rows, days as cells
- Sticky month-divider rows that show "JUNE 2026"
- Today is marked with a primary-colored 2px border
- Weekend cells have a faint diagonal pattern background
- Date range outside `dateRangeStart..dateRangeEnd` is hidden, not greyed (don't clutter)

**Desktop:** same grid, larger cells, optional click-drag-to-range (deferred to Phase 2 if Phase 1 timing is tight).

### V-03 — Hero / Act 1 visual
Re-use pay-me-back's pixel-character + studio scene as the visual default — the same nano-banana sprites work for "person sitting at a laptop planning a trip" as well as they do for "person planning to collect debts". Avoids a generation cycle in Phase 1. New nano-banana sprites can replace them in Phase 3 polish.

## Conventions

### C-01 — Naming
- Package name: `when-we-go`
- All env vars: `WHENWEGO_*` (mirror of `PAYLEO_*`)
- DO class name: `WhenWeGoPollDO`
- Worker name: `when-we-go-api`

### C-02 — Code style
- TypeScript strict mode
- English comments + identifiers, English user-facing copy
- ESM imports with `.js` extensions for local files (Astro 6 convention)
- Components in `src/components/*.astro`, libs in `src/lib/*.ts`, Worker in `worker/`

### C-03 — Attribution + sibling cross-link
BaseLayout ships with two footer elements:
1. **Built-with-when-we-go** badge (same shape as pay-me-back's built-with footer) linking to this repo
2. **Sibling project** mini-link to pay-me-back ("see also: pay-me-back — split costs after the trip")

Both removable via the same env var (`WHENWEGO_HIDE_FOOTERS=true`) for adopters who don't want them.

### C-04 — Demo mode banner
Same env-gated `WHENWEGO_DEMO_MODE=true` mechanic as pay-me-back's `PAYLEO_DEMO_MODE`. Yellow striped banner at the top says "DEMO POLL — votes don't persist anywhere, no one is actually going on this trip".

## Out of scope for Phase 1

(Reminder — these belong to Phase 2+ per ROADMAP)

- Worker code beyond an empty index.ts stub + DO class declaration
- Vote API endpoints
- Date-grid interactivity (Phase 1 ships visual-only grid, Phase 2 wires up the JS)
- Telegram integration
- Overlap calculation
- Auto-close cron
- AI suggestions, booking integrations, payment

## Open questions to revisit in Phase 2

- **Cron frequency for auto-close check:** every hour? every 15 min? (CF Workers free tier allows up to 1/min). Defer to Phase 2 — needs real usage to inform.
- **What happens on revote after poll close:** silently rejected? error message? Defer.
- **Time zones for international participants:** all dates rendered in viewer's local TZ vs. organizer's TZ? Defer — for Copenhagen-trip MVP all participants are in Europe/Berlin so it's moot.

## Code context (reusable assets from pay-me-back)

Files we can port wholesale or with light adaptation:

| pay-me-back file | when-we-go target | Change |
|---|---|---|
| `src/layouts/BaseLayout.astro` | same path | Swap `REPO_URL`, env var name, add sibling link |
| `src/styles/global.css` | same path | Swap `--color-primary` value, keep rest |
| `src/components/CopyButton.astro` | same path | Drop-in port |
| `src/lib/format.ts` | adapt | Strip €-specific stuff, keep date formatters |
| `scripts/prebuild-debtors.mjs` | `scripts/prebuild-polls.mjs` | Rename + adjust validators (poll-shape instead of debtor-shape) |
| `scripts/gen-debtor.mjs` | `scripts/gen-poll.mjs` | Adapt token generation, accept poll metadata |
| `scripts/verify-isolation.mjs` | same | Adapt to verify cross-poll isolation |
| `astro.config.mjs` | same | Identical |
| `tsconfig.json` | same | Identical |
| `public/fonts/*` | same | Wholesale copy |
| `public/sprites/leo-*.png` | placeholder for Phase 1 | Real new sprites in Phase 3 polish |
| `public/_headers` | same | Identical |
| `.nvmrc` | same | Identical |
| `package.json` | adapt | Rename + drop SEPA/QR deps not needed yet |

Files we DO NOT port (PayLeo-specific):
- `worker/lib/sepa-qr.ts`, `src/lib/sepa-qr.ts` — money-specific
- `src/components/PaymentMethodsExtra.astro` — money-specific
- `src/lib/payment-methods.ts` — money-specific
- `src/components/Act3Payment.astro`, `Leaderboard.astro` etc — debtor-specific flows
- `data/debtors.example.json` — replaced with `data/polls.example.json`
