# Phase 2 Plan — Date Polling + Auto-Close

> Atomic-commit-sized tasks for delivering Phase 2. Mirrors Phase 1's plan style.
> All paths relative to `D:/dev/when-we-go/`.

## Tasks

### T-01 — Worker bootstrap + routing
**Files:** `worker/index.ts` (replace Phase 1 stub), `worker/lib/router.ts`, `worker/lib/cors.ts`

**Steps:**
1. Build a tiny request-router in `worker/lib/router.ts`: `Router.get(path, handler)` / `.post(...)` / etc. Pattern matching like `/api/poll`.
2. `worker/index.ts` registers handlers for: `GET /api/health`, `GET /api/poll`, `POST /api/vote`, `GET /api/admin/poll`, `POST /api/admin/close`. Dispatch unknown paths to 404.
3. Wire `scheduled()` handler for cron (no-op stub for now).
4. Define `Env` interface in `worker/index.ts`: bindings (`WHENWEGO_POLL_DO`), secrets (`POLLS_JSON`, `WHENWEGO_TELEGRAM_BOT_TOKEN`, `WHENWEGO_TELEGRAM_CHAT_ID`).
5. CORS helper: same-origin in prod, allow `localhost:4321` in dev.

**Done when:** `wrangler dev` boots, `curl http://localhost:8787/api/health` returns `{ ok: true, phase: 2 }`.

---

### T-02 — Durable Object scaffold + schema
**Files:** `worker/durable-object.ts` (replace Phase 1 stub)

**Steps:**
1. `WhenWeGoPollDO` class with constructor that runs `this.ctx.storage.sql.exec(SCHEMA_DDL)` once.
2. Schema DDL = the 3 CREATE TABLE statements from CONTEXT A-02.
3. Methods (one per future endpoint, all using `this.ctx.storage.sql`):
   - `castVotes(token: string, votes: VoteInput[]): { voteCount: number; wasFirstVote: boolean }`
   - `getVotesForToken(token: string): Vote[]`
   - `getAllVotes(): Vote[]`
   - `getVoterStatus(): VoterStatus[]`  — (token, firstVotedAt, lastVotedAt, voteCount)
   - `getMeta(key: string): string | null`
   - `setMeta(key: string, value: string): void`
   - `closeNow(overlapJson: string): void` — sets `closed_at = Date.now()`, writes overlap_cache
   - `isClosed(): boolean`
4. Each method wraps its SQL in a try/catch + returns typed results.

**Done when:** Class compiles, DO can be exported via `wrangler.toml`'s migration, dry-run deploy succeeds.

---

### T-03 — Zod schemas for all API shapes
**Files:** `worker/lib/schemas.ts`

**Steps:**
1. `VoteStateSchema = z.enum(['yes', 'maybe', 'no'])`
2. `VoteEntrySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), state: VoteStateSchema })`
3. `VoteRequestSchema = z.object({ slug: z.string(), token: z.string(), votes: z.array(VoteEntrySchema).max(400) })` (400 cap = ~1 year of daily votes, prevents abuse)
4. Response types as TypeScript interfaces (no need to validate outgoing)

**Done when:** Compiled, imported by routes in T-05/T-06.

---

### T-04 — Polls config loader + token validation
**Files:** `worker/lib/polls-config.ts`

**Steps:**
1. `loadPolls(env: Env): Poll[]` — parses `env.POLLS_JSON`, throws if invalid (Worker hard-fails — same pattern as pay-me-back's prebuild).
2. `findPoll(env: Env, slug: string): Poll | null`
3. `validateParticipantToken(poll: Poll, token: string): Participant | null`
4. `validateOrganizerToken(poll: Poll, token: string): boolean`
5. `dateInRange(poll: Poll, date: string): boolean` — used by vote validation

**Done when:** Pure helpers, no DO/Worker deps; unit tested.

---

### T-05 — Overlap calculation (pure fn + unit tests)
**Files:** `worker/lib/overlap.ts`, `worker/lib/overlap.test.ts`

**Steps:**
1. Implement `computeOverlap(poll: Poll, votes: Vote[]): Overlap` per CONTEXT A-05.
2. Tier rules:
   - `perfect`: all participants said `yes` on that date
   - `withEffort`: `yes + maybe == participantCount` AND at least 1 `maybe`
   - `oneShort`: `yes == participantCount - 1` (one missing or one no)
3. Build `perDate` first (single pass), then derive per-tier sets, then merge into `ranges` (consecutive ≥2 days).
4. Sort `ranges`: tier order (`perfect > withEffort > oneShort`), then length DESC, then start ASC.
5. Tests:
   - All-yes → all dates in `perfect`
   - All-no → all tiers empty
   - Range merging — 3 consecutive `perfect` days = 1 range length 3
   - Range break — `yes yes no yes yes` = two length-2 ranges
   - One holdout → date in `oneShort`, not in `perfect`
   - Empty input (no votes) → `unvoted = participantCount` everywhere

**Done when:** `node --test worker/lib/overlap.test.ts` exits 0 with 6+ assertions.

---

### T-06 — POST /api/vote endpoint
**Files:** `worker/handlers/vote.ts`

**Steps:**
1. Parse + validate body with `VoteRequestSchema`.
2. Find poll via `findPoll` — 404 if not found.
3. Validate token belongs to slug — 401 if not.
4. Check `isClosed()` on DO — 410 Gone if closed.
5. Validate all `votes[].date` are in `[dateRangeStart, dateRangeEnd]` — 400 if any out.
6. Call DO's `castVotes(token, votes)` — returns `{ voteCount, wasFirstVote }`.
7. If `wasFirstVote` → enqueue Telegram event (fire-and-forget, don't await).
8. Return 200 `{ ok: true, voteCount }`.

**Done when:** Posts valid votes, rejects all of: missing slug, wrong token, closed poll, out-of-range date, malformed body.

---

### T-07 — GET /api/poll endpoint
**Files:** `worker/handlers/poll.ts`

**Steps:**
1. Parse `slug` + `token` from query string.
2. Find poll + validate token.
3. From DO: `getVotesForToken(token)` + `isClosed()` + (if closed) `getMeta('overlap_cache')`.
4. Response shape:
   ```ts
   {
     poll: { slug, title, destination, dateRangeStart, dateRangeEnd, pollCloseAt, participantCount },
     viewer: { name, voteCount },
     votes: Vote[],                                   // viewer's own
     closed: boolean,
     closedAt: string | null,                          // ISO
     overlap: Overlap | null,                          // null pre-close, populated post-close
   }
   ```
5. Cache-Control: `no-store` (votes are fresh).

**Done when:** Returns correct shape pre- + post-close; doesn't leak other participants' votes.

---

### T-08 — GET /api/admin/poll endpoint
**Files:** `worker/handlers/admin-poll.ts`

**Steps:**
1. Read `X-Organizer-Token` header.
2. Parse `slug` from query.
3. Find poll, validate organizer token.
4. From DO: `getAllVotes()` + `getVoterStatus()` + `isClosed()` + maybe `getMeta('overlap_cache')`.
5. Compute fresh overlap (pre-close) OR use cache (post-close).
6. Response shape:
   ```ts
   {
     poll: {...},
     voterStatus: Array<{ name, hasVoted: boolean, firstVotedAt: number|null, lastVotedAt: number|null, voteCount: number }>,
     overlap: Overlap,
     closed: boolean,
     closedAt: string | null,
   }
   ```
7. Auth failure → 404 (not 401, to avoid leaking that the slug exists with a wrong token; mirrors pay-me-back's admin route enumeration protection).

**Done when:** Organiser sees the full picture; wrong tokens get 404.

---

### T-09 — POST /api/admin/close endpoint
**Files:** `worker/handlers/admin-close.ts`

**Steps:**
1. Same auth as T-08.
2. Find poll. If already closed → 200 with `{ alreadyClosed: true }`.
3. Compute current overlap.
4. DO `closeNow(JSON.stringify(overlap))`.
5. Fire close-summary Telegram (best effort).
6. Return `{ ok: true, closedAt: now }`.

**Done when:** Manual close works; idempotent.

---

### T-10 — Scheduled handler (auto-close cron)
**Files:** `worker/scheduled.ts`, update `wrangler.toml` with `[triggers] crons = ["0 * * * *"]`

**Steps:**
1. `scheduled(event, env, ctx)` exports from `worker/index.ts`.
2. Logic per CONTEXT A-06: for each poll, skip if closed or not yet due, else `closeNow()` + send close-notification.
3. Use `ctx.waitUntil()` for fire-and-forget Telegram calls.

**Done when:** Verified via local `wrangler dev --test-scheduled` invocation (set a poll close to past, run cron, verify DO `closed_at` is set).

---

### T-11 — Telegram notification pipeline
**Files:** `worker/lib/telegram.ts`, `worker/lib/notify-pipeline.ts`

**Steps:**
1. Port `telegram.ts` from pay-me-back — raw fetch to `api.telegram.org/bot{TOKEN}/sendMessage`, 5s timeout.
2. `notify-pipeline.ts` exports `notifyFirstVote(env, { pollTitle, voterName, votedSoFar, totalParticipants })` and `notifyPollClose(env, { pollTitle, overlap })`.
3. Format helpers for the 3 message shapes from CONTEXT A-07.
4. If env vars unset → returns `{ ok: false, skipped: true }` silently.

**Done when:** Setting real WHENWEGO_TELEGRAM_* env vars + triggering a first-vote actually pings Leo's phone.

---

### T-12 — Wire calendar grid interactivity
**Files:** `src/components/CalendarGrid.astro` (extend), `src/pages/[slug]/[token].astro` (add `<script define:vars>` block + state IIFE)

**Steps:**
1. Add `id`s + `data-date` attributes to each cell button (already structured for this in Phase 1).
2. Inline `<script define:vars={{ token, slug, publicApiBase, dateRangeStart, dateRangeEnd }}>` in the page:
   - On `DOMContentLoaded`: fetch `GET /api/poll`, restore vote state into cells
   - Click handler on grid: cycle state → re-render cell visually → debounce 500ms → `POST /api/vote`
   - Show "saving…" indicator near grid during in-flight; success/error toast on completion
   - On `visibilitychange` (page back to focused): refetch state
   - If response says `closed: true` → make grid read-only, render overlap badges on perfect/withEffort cells, show summary banner
3. Pure CSS for cell-state visuals (no JS-driven styles); JS just adds/removes class names: `cell-yes`, `cell-maybe`, `cell-no`, `cell-unset`, `cell-perfect`, `cell-witheffort`, `cell-oneshort`, `cell-readonly`.
4. Error toast component is inline (no React/Vue — just a `<div>` that we show/hide).

**Done when:** End-to-end: open the participant page → tap dates → reload page → tap state survives → close poll → reload → see overlap badges.

---

### T-13 — Wire admin dashboard
**Files:** `src/pages/[slug]/admin/[token].astro` (extend Phase 1 skeleton)

**Steps:**
1. `<script define:vars={{ slug, organizerToken, publicApiBase }}>`:
   - `fetch(GET /api/admin/poll, { headers: { 'X-Organizer-Token': organizerToken } })` on load
   - Render voter status list, per-date stacked bars, viable ranges panel, close-state indicator
   - Auto-refresh every 30s while not-closed
   - "Force close now" button → POST `/api/admin/close` → re-fetch
2. Stacked bar = pure CSS flex with widths from data (no chart library).
3. Viable ranges panel: tier-grouped (perfect / with effort / one short), human-readable date strings ("Jul 12 – Jul 15 (4 days)").

**Done when:** Organiser sees live aggregate, force-close button works, post-close view shows cached overlap.

---

### T-14 — Local end-to-end smoke test
**Files:** `scripts/smoke-test.mjs`

**Steps:**
1. Adapt pay-me-back's smoke-test pattern. Tests against `wrangler dev` URL by default:
   - `GET /api/health` → 200 + correct shape
   - `POST /api/vote` with valid body → 200
   - `POST /api/vote` with invalid token → 401
   - `POST /api/vote` with closed poll → 410 (manually close via `/api/admin/close` first)
   - `GET /api/poll` → 200 + correct shape pre/post close
   - `GET /api/admin/poll` with org token → 200
   - `GET /api/admin/poll` with bad org token → 404
2. Add `npm run smoke` script.

**Done when:** Smoke test green against `wrangler dev` instance.

---

### T-15 — Build verify + dry-run deploy
**Files:** None (CLI commands only)

**Steps:**
1. `npm run build` — Astro static build still succeeds
2. `node scripts/verify-isolation.mjs` — still passes
3. `node --test worker/lib/overlap.test.ts` — passes
4. `npx wrangler deploy --dry-run` — Worker compiles cleanly, no missing bindings
5. `npm run smoke` against `wrangler dev` — all green

**Done when:** All five green.

---

### T-16 — Commit + push to private repo
**Steps:** standard commit message, push to `Leonardboeker/when-we-go` (still private).

---

## Acceptance criteria for Phase 2 done

All of:
1. Worker handles all 5 endpoints with correct auth + validation
2. Durable Object schema initialised; votes + history + meta tables work
3. Overlap calc has ≥ 6 passing unit tests
4. Cron handler closes overdue polls + fires close notification (manually verified via `wrangler dev --test-scheduled`)
5. Participant page: tap cells → state persists → reload preserves state → close poll → see overlap badges
6. Admin page: live aggregate updates every 30s; force-close works
7. Telegram notifications fire on first-vote-per-token + on close (when env vars set)
8. Smoke test green
9. Wrangler `--dry-run` deploy clean
10. Phase 1 isolation test still passes
11. STATE.md updated, commit pushed to private GitHub repo

## What Phase 2 explicitly does NOT include

- ❌ Production Worker deploy (you decide when; one `npm run worker:deploy` command away)
- ❌ Demo deployment to pages.dev (Phase 3)
- ❌ Public GitHub flip (Phase 3 after polish)
- ❌ New nano-banana sprites (Phase 3)
- ❌ OG preview images per poll (Phase 3)
- ❌ Drag-to-range selection (Phase 3 polish)
- ❌ Resend email fallback (Phase 3+ if requested)
- ❌ Multi-poll dashboards (out of scope)

## Order of execution

Linear: T-01 → T-02 → T-03 → T-04 → T-05 → T-06 → T-07 → T-08 → T-09 → T-10 → T-11 → T-12 → T-13 → T-14 → T-15 → T-16.

T-05 (overlap calc) is the most fragile; do it early so downstream endpoints can rely on it. T-11 (Telegram) is independent of UI — could run anytime after T-06.
