# Phase 2 Context — Date Polling + Auto-Close

> Locked decisions for Phase 2 (vote persistence, overlap calc, auto-close cron, Telegram notifications).
> Picks up from Phase 1 (static foundation already shipped).

## Architecture decisions

### A-01 — One Durable Object instance per poll
Each poll's state lives in its own DO instance, keyed by `slug` via `env.WHENWEGO_POLL_DO.idFromName(slug)`. Rationale:
- Clean isolation — Copenhagen poll never reads from another poll's DO
- Scales independently per poll
- Mirrors pay-me-back's pattern of one DO per debt-collection campaign
- Simpler to reason about + easier to nuke a single poll's data later

DO class: `WhenWeGoPollDO` (matches Phase 1 stub name in `wrangler.toml`).

### A-02 — SQLite-backed DO with three tables
```sql
-- per-(participant, date) vote rows; absence = unset/no
CREATE TABLE IF NOT EXISTS votes (
  token       TEXT NOT NULL,
  date        TEXT NOT NULL,        -- ISO YYYY-MM-DD
  state       TEXT NOT NULL,        -- 'yes' | 'maybe' | 'no'
  updated_at  INTEGER NOT NULL,     -- unix ms
  PRIMARY KEY (token, date)
);

-- per-participant metadata; used for "did they vote yet" + notifications
CREATE TABLE IF NOT EXISTS vote_history (
  token            TEXT PRIMARY KEY,
  first_voted_at   INTEGER NOT NULL,
  last_voted_at    INTEGER NOT NULL,
  vote_count       INTEGER NOT NULL DEFAULT 1
);

-- catch-all metadata for poll state
CREATE TABLE IF NOT EXISTS poll_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
-- known keys:
--   closed_at         ISO timestamp when poll was auto-closed (set by cron)
--   close_notified_at unix ms when close-notification was sent (idempotency)
--   overlap_cache     JSON blob of computed overlap (set on close, served from here)
```

`state = 'no'` is stored explicitly (not absent) so the API can distinguish "answered no" from "didn't vote yet". `vote_count` is incremented on every API call so we can tell people apart by activity level if needed later.

### A-03 — API surface (5 endpoints)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/poll?slug=X&token=Y`     | participant token | Returns viewer's votes + poll meta. Post-close, also returns overlap. |
| POST | `/api/vote`                    | participant token (in body) | Bulk replace viewer's votes. Idempotent. |
| GET  | `/api/admin/poll?slug=X`       | `X-Organizer-Token` header | Aggregate per-date breakdown + who voted yet + overlap. |
| POST | `/api/admin/close?slug=X`      | `X-Organizer-Token` header | Force-close a poll (skip waiting for cron). |
| GET  | `/api/health`                  | none | Returns `{ ok: true, phase: 2 }`. Smoke test target. |

All bodies are JSON; all errors return `{ error: string }` + HTTP status. Token validation: looks up `slug` in `POLLS_JSON`, then checks the supplied token against `participants[].token` or `organizerToken`.

**Auth note:** participant tokens flow in the request body for POSTs (consistent with where they came from — the page URL). Organizer tokens go in the header (matches pay-me-back's `X-Admin-Token` pattern).

### A-04 — Bulk vote replace (idempotent)
`POST /api/vote` body:
```ts
{
  slug: string,
  token: string,
  votes: Array<{ date: string, state: 'yes' | 'maybe' | 'no' }>
}
```
Server logic in the DO (single transaction):
1. Validate `slug` + `token` against `POLLS_JSON` (token must belong to slug)
2. Reject if `poll_meta.closed_at` is set (410 Gone)
3. Reject if any `date` falls outside the poll's `dateRangeStart..dateRangeEnd` (400)
4. Delete all existing `votes` rows for this token
5. Insert one row per submitted `{date, state}` (where `state !== 'unset'`)
6. Upsert `vote_history(token)` — `first_voted_at` only if INSERT, always update `last_voted_at` + bump `vote_count`
7. Return `{ ok: true, voteCount: N }`

Idempotent because step 4 wipes existing votes first. Client can resubmit the full state on every change without worrying about deltas.

### A-05 — Overlap calculation
Pure function in `worker/lib/overlap.ts`. Input: poll config + array of `{token, date, state}` rows. Output:
```ts
type Overlap = {
  perDate: Record<string, { yes: number; maybe: number; no: number; unvoted: number }>;
  perfect: string[];                // dates where all participants said 'yes'
  withEffort: string[];             // dates where (yes + maybe) == participantCount AND at least 1 maybe
  oneShort: string[];               // dates where yes == participantCount - 1
  ranges: Array<{ start: string; end: string; tier: 'perfect' | 'withEffort' | 'oneShort'; length: number }>;
};
```
`ranges` enumerates consecutive sequences of ≥ 2 days at each tier, sorted: perfect ranges first, longest first within tier. Used by both `/api/poll` (post-close) and `/api/admin/poll`.

Unit-tested in `worker/lib/overlap.test.ts` (run via `node --test`):
- All-yes case → all dates in `perfect`
- One holdout case → that date in `oneShort`
- Partial votes → unvoted count is correct
- Range merging — 5 consecutive perfect days = one range `length: 5`
- Range break on missing/wrong-tier day

### A-06 — Auto-close cron (hourly)
Wrangler scheduled handler at `cron = "0 * * * *"` (top of every hour). Logic:
1. For each poll in `POLLS_JSON`:
2. Skip if `poll_meta.closed_at` already set
3. Skip if `now < pollCloseAt`
4. Open the poll's DO, run `closeNow()`:
   - Set `poll_meta.closed_at = now`
   - Compute overlap from all votes, write to `poll_meta.overlap_cache`
   - If `poll_meta.close_notified_at` is unset:
     - Fire Telegram notification with overlap summary
     - Set `poll_meta.close_notified_at = now`

Hourly is fine; max delay is 1h after `pollCloseAt`. Bandwidth: at most 1 DO touch per poll per hour even when nothing changes.

### A-07 — Telegram notifications (3 events)
Reuses pay-me-back's `notify-pipeline.ts` shape (`worker/lib/telegram.ts` + `worker/lib/notify-pipeline.ts`). Fires on:

| Event | When | Message shape |
|---|---|---|
| First vote per person | First successful `POST /api/vote` from a given token | `🗳️ Sister voted on copenhagen-2026 (3 of 4 voters now in)` |
| Close summary | Cron runs `closeNow()` for a poll | `🎉 copenhagen-2026 closed. Perfect dates: Jul 12-15 (4 days). With effort: Jun 28 - Jul 5 (8 days).` |
| Close summary — no overlap | Same trigger, but overlap is empty at every tier | `😕 copenhagen-2026 closed. No dates work for everyone. Best is 3-of-4 on Jul 18-20.` |

All notifications are best-effort — failures logged, never block the API response.

Env vars (mirror pay-me-back):
- `WHENWEGO_TELEGRAM_BOT_TOKEN`
- `WHENWEGO_TELEGRAM_CHAT_ID`

When unset → notifications silently skipped, API still works.

### A-08 — Calendar grid interactivity
Vanilla JS Astro island. Same philosophy as pay-me-back: hand-written `<script>` block, no framework runtime.

**State machine per cell:**
```
unset → tap → yes → tap → maybe → tap → no → tap → unset
```

**Implementation:**
- One global object `{ [date]: 'yes' | 'maybe' | 'no' | 'unset' }` initialised from server response
- Tap a cell → mutate object → re-render cell visuals immediately (optimistic)
- Debounce: 500ms after last tap, fire `POST /api/vote` with full state
- On success: clear "saving..." indicator. On failure: revert + show error toast
- On page focus: refetch `GET /api/poll?slug=X&token=Y` to get latest server state (in case user voted from another device)

**Visual states:**
- `yes`: solid primary background, white text
- `maybe`: striped diagonal pattern on surface-container, dark text
- `no`: surface-container-lowest with reduced opacity, dark text
- `unset`: bare cell, no background

No long-press selector in Phase 2 — tap-cycle handles all cases. Drag-to-range is Phase 3 polish if it turns out tapping 30+ cells one at a time is painful.

### A-09 — Post-close UI
After `pollCloseAt`:
- Calendar grid becomes read-only (no more taps)
- Cells get a third state badge: "✓" for perfect overlap dates, "~" for with-effort, "·" for one-short
- A summary banner shows above the grid: "🎉 Best dates: Jul 12-15" (or sad equivalent)
- Vote-history is still shown (user's own votes visible) but greyed slightly

### A-10 — Admin dashboard wiring
`/<slug>/admin/<organizerToken>/` becomes live, fetching `/api/admin/poll?slug=X`:
- Top: poll meta + countdown (or "closed N hours ago")
- "Voted yet" list: each participant with ✓ if they have any votes, otherwise ✗ + last-poked time
- Per-date stacked bar (yes/maybe/no/unvoted) — visually scannable
- "Viable ranges" panel — same overlap tiers as participant post-close view
- "Force close now" button → `POST /api/admin/close?slug=X` (skip waiting for cron)
- Refresh button to re-fetch

Auto-refresh every 30s while open; on close-state, switches to static snapshot.

## Data flow summary

```
Participant taps cell
  → optimistic local update + debounce 500ms
  → POST /api/vote { slug, token, votes: [all] }
    → Worker: validate slug+token via POLLS_JSON
      → DO: replace votes table for token, upsert vote_history
        → if first vote ever for token → enqueue Telegram event
      → return { ok, voteCount }

Cron tick (hourly)
  → for each poll in POLLS_JSON:
    → if now >= pollCloseAt and not closed yet:
      → DO: closeNow()
        → set closed_at
        → compute overlap, store in poll_meta.overlap_cache
        → fire Telegram close-summary event
        → mark close_notified_at

Participant opens page (post-close)
  → GET /api/poll?slug&token
    → DO: read votes for token + closed_at + overlap_cache
    → return { votes, closed: true, overlap }
  → page renders read-only grid with overlap badges + summary banner

Organiser opens admin page
  → GET /api/admin/poll?slug (X-Organizer-Token header)
    → Worker: validate organizer token
      → DO: read all votes + vote_history + poll_meta
        → compute overlap (if not closed yet; cache hit if closed)
      → return aggregate {perDate, viableRanges, voterStatus[]}
```

## Conventions for Phase 2 code

- All Worker code under `worker/`, mirror of pay-me-back's structure (`worker/index.ts` router, `worker/durable-object.ts` DO class, `worker/lib/*` helpers)
- Zod schemas in `worker/lib/schemas.ts` for every API request/response shape
- Pure functions extracted (overlap calc, date helpers) and unit-tested via `node --test`
- No external services beyond Telegram for MVP (no Resend, no Stripe etc — keep it tight)
- Client JS lives inline in the per-page `<script>` block; shared helpers in `src/lib/*` get inlined by Astro's static build (still zero runtime framework)

## Open questions for future phases

- Multi-poll dashboards (Phase 3+ if Leo runs more than 1)
- Time-of-day granularity for half-day trips
- Resend email fallback for adopters without Telegram
- AI suggestions (route via Cloudflare AI Workers binding — free tier)
- pay-me-back integration: closed-poll button → "create matching pay-me-back instance for this trip"

None of those block Phase 2.

## What Phase 2 explicitly does NOT include

- Demo deployment (Phase 3)
- New nano-banana sprites (Phase 3)
- OG preview images (Phase 3)
- Public GitHub flip (Phase 3)
- Per-day time-of-day picker
- Drag-to-range selection (Phase 3 polish)
- Push notifications / browser notification API
- Real-time updates via Server-Sent Events (polling on focus is enough)
