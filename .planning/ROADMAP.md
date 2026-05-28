# Roadmap

> MVP scope only. Post-MVP phases listed at the bottom as "Future" — not promises, just where the project could go.

## Phase 1 — Foundation (estimated: 1 weekend)

**Goal:** Repo + tech stack + token model in place, single test poll renders end-to-end as a static site (no Worker yet).

**Deliverables:**
- Astro + Tailwind v4 project bootstrapped (same Vite-plugin pattern as pay-me-back)
- `data/polls.json` schema + example poll
- `src/data/polls.ts` typed import + token model (mirror of pay-me-back's `debtors.ts`)
- `src/pages/[slug]/[token].astro` — per-participant page, prerendered, no interactivity yet
- `src/pages/[slug]/admin/[token].astro` — organiser page, prerendered, static snapshot of poll config
- `BaseLayout` ported from pay-me-back with attribution footer (linking back to GitHub + sibling project)
- `wrangler.toml` configured with placeholder route
- `prebuild` script that materialises `polls.json` from `WHENWEGO_POLLS_JSON` env var (mirror of pay-me-back)
- Smoke test: `npm run build` produces correct dist with token-isolation verified

**Goal-backward check:** Can Leo paste the 4 Copenhagen URLs into WhatsApp and have each family member see a personalised greeting + the empty date grid?

## Phase 2 — Date Polling + Auto-Close (estimated: 1-2 weekends)

**Goal:** Full MVP. Votes persist, poll auto-closes, organiser sees overlap.

**Deliverables:**
- Cloudflare Worker + Durable Object (SQLite) — `Poll` DO holds per-token vote arrays
- `POST /api/vote` — body `{ slug, token, votes: [{date, state}] }`, idempotent (overwrites previous selection)
- `GET /api/poll?slug=X&token=Y` — returns viewer's own votes pre-close, full overlap post-close
- `GET /api/admin/poll?slug=X` — organiser-token-gated; returns aggregate per-date breakdown
- Scheduled handler (`cron = "0 * * * *"`) — checks for expired polls, runs overlap calc, fires close notification
- Date-grid component with tap-to-cycle UI (no / maybe / yes) — vanilla JS island, no framework hydration
- Overlap calc — pure function in `worker/lib/overlap.ts`, unit tested
- Telegram notification pipeline (port from pay-me-back's `notify-pipeline.ts`)
- Smoke test against deployed site: full vote flow → close → overlap shows up

**Goal-backward check:** Can the 4 family members vote, can Leo's phone get a Telegram ping when the poll closes 2 weeks later, does he see the correct overlap dates?

## Phase 3 — Polish + Documentation (estimated: half a weekend)

**Goal:** Make the repo public-ready as a sibling template to pay-me-back.

**Deliverables:**
- README with same structure as pay-me-back (banner, badges, TOC, use-cases, deploy guide)
- Demo deployment to `when-we-go-demo.pages.dev` with `WHENWEGO_DEMO_MODE=true` banner
- Per-poll OG preview image (poll title + days-until-close + participant count)
- `gh repo create when-we-go --public --template`
- Cross-links in both repos' READMEs ("see also pay-me-back / when-we-go")
- One real run: actual Copenhagen poll goes live for Leo's family

**Acceptance:** the Copenhagen trip plan ends up scheduled because of this tool.

---

## Future (not promised, not planned)

These are the "where could it go next" notes for after the MVP earns its keep. Each is a candidate Phase 4+; only revisit if the MVP actually gets used.

- **AI trip suggestions** — once dates are locked, hit an LLM with `{location, dates, group size, budget?}` and surface hotel + activity options. Probably Cloudflare AI Workers binding (free tier).
- **Booking-platform deep-links** — link straight to Booking.com / Airbnb search for the locked dates.
- **pay-me-back integration** — "trip is confirmed → generate a pay-me-back instance for the agreed costs, pre-populated with each participant as a debtor". The two tools naturally compose; the integration would be a one-button bridge.
- **Time-of-day granularity** — for shorter trips ("which evening this week?") rather than full days.
- **Multi-poll dashboards** — if Leo ends up using this 5+ times, an aggregate "my polls" view becomes worth it.
- **Recurring polls** — "every Friday, who's up for dinner?" — needs an account model, big scope expansion.
