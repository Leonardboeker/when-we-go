# Requirements — MVP

> Scope: bare minimum that solves the Copenhagen-trip use case end-to-end.
> Source of truth for what Phase 1 + Phase 2 must deliver.

## Functional

### F-01 — Poll creation (organiser flow)
The organiser can create a new poll by editing a config file (same shape as `pay-me-back`'s `data/debtors.json`). For MVP, no UI for poll creation — JSON-edit + git commit + redeploy is the workflow.

Each poll has:
- `slug` — short URL-safe identifier (e.g. `copenhagen-2026`)
- `title` — human-readable name (e.g. `Copenhagen trip — 4 of us`)
- `dateRangeStart` / `dateRangeEnd` — the calendar window participants pick from (e.g. `2026-06-01` to `2026-09-30`)
- `pollCloseAt` — when the poll auto-closes (ISO timestamp)
- `participants` — array of `{ token, name }` objects, one per person
- `organizerToken` — separate token that sees aggregate results

### F-02 — Per-participant token URL
Each participant has a unique URL `/<slug>/<token>/` that:
- Greets them by name
- Shows the date-range as a tappable calendar/grid
- Lets them mark each day as one of: `yes` (free), `maybe` (free with effort), `no` (default — busy/unmarked)
- Persists their selection on tap (no "save" button)
- Shows a countdown to `pollCloseAt`
- Before close: shows ONLY their own answers
- After close: shows the overlap dates highlighted

### F-03 — Date-grid UI
Mobile-first calendar grid:
- One row per week
- Each cell = one day, three-state toggle: `no` / `maybe` / `yes` (click cycles, long-press resets)
- Visible week-headers + month dividers
- Today is visually marked
- Weekends visually distinct

Desktop: same grid, larger touch targets, optional click-drag to mark a range.

### F-04 — Polling-window auto-close
A Cloudflare Worker scheduled handler (cron) checks once an hour whether any poll has passed its `pollCloseAt`. When found:
- Marks the poll as `closed`
- Computes overlap (see F-05)
- Sends organiser notification (Telegram, see F-07)

No further votes accepted after close; participants see the overlap.

### F-05 — Overlap calculation
For a closed poll:
- For each date in the range, count `yes` and `maybe` votes
- A date "works for everyone" iff `yes count == participant count`
- A date "works with effort" iff `(yes + maybe) count == participant count` AND at least one `maybe`
- A date "works for most" iff `yes count == participant count - 1` (one holdout)

Output is a sorted list of viable ranges (sequences of ≥ 2 consecutive working days).

### F-06 — Organiser dashboard
`/<slug>/admin/<organizerToken>/` shows:
- Stacked summary per date (how many yes / maybe / no)
- The viable ranges from F-05
- Who has and hasn't voted yet (just name + last-voted timestamp)
- Pre-close: live, polling /api/poll on focus
- Post-close: static snapshot

### F-07 — Notifications (optional)
If `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set:
- One-liner ping when someone votes for the first time
- Daily digest while poll is open: "3 of 4 voted, 2 days left"
- Summary on auto-close: "Poll closed. Best dates: July 12-15."

### F-08 — Attribution footer
Same pattern as pay-me-back: small "Built with when-we-go — make your own" footer at the bottom of every page, linking back to the GitHub repo.

## Non-functional

### NF-01 — Privacy
Participants never see each other's individual answers. The overlap view shows only aggregates ("3 of 4 say yes"), not "Anna said no". This is the soft-norm version of the same privacy guarantee pay-me-back makes for debt amounts.

### NF-02 — No accounts
Token URLs only. No email, no password, no OAuth. Losing your token = losing access (organiser can rotate by editing config + redeploying).

### NF-03 — Mobile-first
Most votes will happen on phones in 30-second chunks. The calendar grid must work with thumbs; the page must load in < 1s on a 4G connection.

### NF-04 — Free tier
Same Cloudflare free-tier budget as pay-me-back: 100K requests/day, 500 builds/month, free DO + Worker. A poll with 4 people for 2 weeks should consume a single-digit percentage of those.

### NF-05 — Data retention
30 days after `pollCloseAt`, the Durable Object purges the poll's data automatically. Source-of-truth (the config JSON) is in git and survives indefinitely; the vote data does not.

## Out of scope (MVP)

- AI-assisted activity / hotel / flight suggestions
- Booking platform integrations
- Currency / payment collection (use `pay-me-back` when the time comes)
- Multi-poll dashboards
- Account-based recurring use ("my polls")
- Email notifications (Telegram only for MVP)
- Time-of-day granularity (full-day only)
- Time-zone handling beyond Europe/Berlin
- Translation (English only for MVP — sibling pay-me-back ships en-only too)

## Acceptance criteria

The MVP is "done" when:
1. Leo can create a Copenhagen poll by editing a JSON file and redeploying
2. All 4 family members successfully vote on their phones in < 1 minute each
3. The poll auto-closes after 2 weeks without manual intervention
4. The organiser dashboard correctly identifies the overlap dates
5. Total Cloudflare cost for the entire flow is €0
