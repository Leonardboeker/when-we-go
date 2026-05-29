# Phase 10 Plan — pay-me-back Integration

> Admin "split costs" panel + JSON export endpoint matching pay-me-back's debtor schema.
> All paths relative to `D:/dev/when-we-go/`.

## Tasks

### T-01 — DO cost_split table
**Files:** `worker/durable-object.ts`

```sql
CREATE TABLE IF NOT EXISTS cost_split (
  token            TEXT PRIMARY KEY,
  hotel_share_eur  INTEGER NOT NULL DEFAULT 0,
  flight_eur       INTEGER NOT NULL DEFAULT 0,
  other_eur        INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);
```

Methods:
- `getCostSplit(token): CostSplitRow | null`
- `getAllCostSplits(): CostSplitRow[]`
- `setCostSplit(token, {hotelShareEur, flightEur, otherEur, notes?}): void` (upsert)

### T-02 — Default cost calculation
**Files:** `worker/lib/cost-defaults.ts` (new)

`computeDefaultsForPoll(poll, participants, profilesByToken, proposalCache): Map<token, CostSplitRow>`:
- Hotel share: `chosenHotel?.totalPriceEur / participantCount` rounded up (read from `poll_meta.chosen_hotel` set in Phase 6 — for now, returns 0 if unset)
- Flight cost: cheapest from `proposal_cache['flights:<token>']` (Phase 5) — for now, returns 0 if unset
- Other: 0 by default

When Phase 5/6 ship, defaults populate automatically. For now: all zeros, organiser fills manually.

### T-03 — API endpoints
**Files:**
- `worker/handlers/admin-cost-split.ts` (new) — `GET /api/admin/cost-split?slug=X` returns `{participants: [{token, name, hotelShareEur, flightEur, otherEur, totalEur, notes}], chosenHotel?, defaultsApplied: boolean}`. Organiser-token gated.
- Same handler for `POST` — body `{splits: [{token, hotelShareEur, flightEur, otherEur, notes?}]}` — bulk update.
- `worker/handlers/admin-export-paymeback.ts` (new) — `GET /api/admin/export-paymeback?slug=X` returns the pay-me-back-shaped JSON ready for clipboard paste.

Export JSON shape (matching pay-me-back's `data/debtors.json`):
```json
[
  {
    "token": "<freshly-generated-nanoid-16>",
    "name": "Sister",
    "amount": 224,
    "backstory": "Copenhagen, Denmark trip Jul 12-15 — your share of hotel (€105) + flight from Munich (€119)",
    "characterSlug": "placeholder",
    "createdAt": "2026-07-16T00:00:00Z"
  }
]
```

CRITICAL: tokens in export are **fresh** nanoid(16), NOT when-we-go participant tokens (privacy boundary).

### T-04 — Admin dashboard "Split costs" panel
**Files:** `src/pages/[slug]/admin/[token].astro` (extend), `src/components/CostSplitPanel.astro` (new)

Post-close section appears only if `isClosed` and trip_start in past (or always — debatable; for MVP show always after close):
- Table: rows = participants, cols = Hotel / Flight / Other / Total / Edit / Notes
- Inline-editable cells via `<input type="number">` with debounced auto-save (300ms after blur or change)
- "Export to pay-me-back JSON" button → fetches `/api/admin/export-paymeback`, opens modal with `<textarea>` containing pretty-printed JSON + "Copy to clipboard" button + link to https://github.com/Leonardboeker/pay-me-back#quick-start

### T-05 — Smoke test extension
**Files:** `scripts/smoke-test.mjs`

Add:
- `GET /api/admin/cost-split?slug=X` with org → 200 + correct shape
- `POST /api/admin/cost-split?slug=X` → 200, persists
- Re-`GET` → returns the saved values
- `GET /api/admin/export-paymeback?slug=X` → 200 + valid JSON array with N entries matching participant count
- Each export entry has the 5 required fields
- Tokens in export are different from participant tokens (privacy check)
- Wrong org token on either endpoint → 404

### T-06 — Build verify + smoke
1. `npm run build` → still 7+ pages
2. `verify-isolation` → exit 0
3. All previous test suites still pass
4. `wrangler deploy --dry-run` → clean
5. `wrangler dev` + smoke → 31 existing + new = 35+ checks pass

## Acceptance

- Admin sees the split-cost panel post-close
- Inline-edit + save works
- Export button produces JSON parseable by pay-me-back's prebuild-debtors.mjs
- Tokens in export are NOT reused from when-we-go (privacy boundary preserved)
- Backstory string includes destination + date range + per-person breakdown
- Phase 9 + earlier smoke tests still green
