# Phase 10 Context — pay-me-back Integration

> One-click export of trip costs to a pay-me-back compatible JSON, so the post-trip "who owes what" gets handled by the sister project.

## Goal

After the trip is locked + costs are known (hotel + each person's flight), the organiser can click one button to export a JSON they paste into a [pay-me-back](https://github.com/Leonardboeker/pay-me-back) instance — pre-populated with the trip's participants as debtors.

## Decisions

### D-01 — No live API integration

We don't auto-create pay-me-back instances from when-we-go. Reasons:
- pay-me-back is template-based — adopters self-host
- Creating a pay-me-back deployment programmatically would require knowing the adopter's CF account / git creds
- Manual paste-into-JSON is a 30-second user action, not worth automation

What we DO build: JSON export + clipboard copy + link to pay-me-back's quick-start.

### D-02 — Export shape

pay-me-back expects in `data/debtors.json`:

```json
[
  {
    "token": "<nanoid-16>",
    "name": "Sister",
    "amount": 280,
    "backstory": "Copenhagen trip Jul 12-15 — your share of hotel (€105) + flight from Munich (€175)",
    "characterSlug": "placeholder",
    "createdAt": "2026-07-16T00:00:00Z"
  },
  ...
]
```

Our export endpoint generates this for each participant:

```ts
{
  token: nanoid(16),                              // fresh — DO NOT reuse when-we-go tokens
  name: participant.name,
  amount: hotelShare + flightCost,                // editable in admin UI
  backstory: `${poll.destination} trip ${start}-${end} — your share of hotel (€${hotelShare}) + flight from ${origin} (€${flightCost})`,
  characterSlug: 'placeholder',                   // adopter swaps later
  createdAt: new Date().toISOString()
}
```

### D-03 — Cost computation

Defaults sourced automatically:
- **Hotel share**: `chosen_hotel.totalPriceEur / participantCount` (rounded up)
- **Flight cost**: cheapest flight from participant's personalised list (per Phase 5 cache)
- **Total**: hotel + flight per person

Organiser can edit any amount in the admin UI before exporting.

Edge cases:
- No chosen hotel → hotel share = 0, organiser fills in manually
- No flight data for a participant → flight cost = 0, organiser fills in
- Participant didn't have a profile / didn't attend → exclude from export (or include with amount=0)

### D-04 — UI: Split-costs panel in admin

Post-trip section in admin dashboard:

```
🪙 SPLIT COSTS

Pre-fills based on chosen hotel + each person's cheapest flight.
Edit amounts as needed, then export.

| Participant | Hotel share | Flight   | Other  | Total | 
| Leo         |     €105    |   €78    |   €0   | €183  |  [edit]
| Sister      |     €105    |  €119    |   €0   | €224  |  [edit]
| Dad         |     €105    |  €145    |   €0   | €250  |  [edit]
| Brother     |     €105    |  €189    |   €0   | €294  |  [edit]

[ Export to pay-me-back JSON ]
```

Click "Export" → modal with the rendered JSON in a `<textarea>` + "Copy to clipboard" + "Open pay-me-back setup guide" link.

### D-05 — API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/cost-split?slug=X` | organiser | Returns the suggested cost split |
| POST | `/api/admin/cost-split?slug=X` | organiser | Save edited amounts (DO `poll_meta`) |
| GET | `/api/admin/export-paymeback?slug=X` | organiser | Returns the pay-me-back-shaped JSON |

### D-06 — DO addition

```sql
CREATE TABLE IF NOT EXISTS cost_split (
  token            TEXT PRIMARY KEY,
  hotel_share_eur  INTEGER NOT NULL DEFAULT 0,
  flight_eur       INTEGER NOT NULL DEFAULT 0,
  other_eur        INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);
```

### D-07 — Honest accounting hooks

Optional "Other" column for catch-all (meals, taxis, etc.). Organiser fills in manually after the trip; no automated tracking.

For "split fairly" cases — only one person paid for groceries, everyone owes them 1/N — pay-me-back's mental model handles this naturally (one debtor per relationship). Adopter just runs N pay-me-back instances if they want fully-symmetric splitting.

### D-08 — Privacy across the boundary

Tokens in the export are FRESH (newly generated), not when-we-go participant tokens. Reason:
- when-we-go tokens are designed to let someone vote on a trip (different threat model)
- pay-me-back tokens are designed to let someone confirm a payment (different operations)
- Reusing would leak: "Sister's pay-me-back URL is the same as her when-we-go URL" → less anonymity

Names + amounts cross the boundary; tokens don't.

### D-09 — Optional auto-bridge (future, not Phase 10)

If when-we-go and pay-me-back are co-hosted under same adopter:
- Adopter could set `WHENWEGO_PAYMEBACK_REPO_PATH=/dev/pay-me-back`
- Then export button could write directly to that repo's `data/debtors.json` (still local, not network)
- Out of scope for first cut

## What's intentionally NOT in this phase

- Auto-deploying a pay-me-back instance (template adopters host their own)
- Cross-token bridging (privacy reasons — fresh tokens)
- Fully-symmetric split-evenly logic with multiple payers — pay-me-back's relationship model handles this, no need to add here
- Currency conversion — assume EUR throughout (pay-me-back is EUR-only currently)
- Receipt OCR / expense tracking — way out of scope

## Acceptance criteria

1. Admin dashboard post-trip shows "Split costs" panel with defaults
2. Inline editing of amounts persists in DO
3. "Export to pay-me-back" returns valid JSON that pastes cleanly into pay-me-back's `data/debtors.json`
4. Tokens in export are fresh (not when-we-go participant tokens)
5. Backstory includes destination + dates + breakdown
6. End-to-end test: take exported JSON → paste into a pay-me-back clone → `npm run build` succeeds → per-token pages render for each participant with correct amounts
