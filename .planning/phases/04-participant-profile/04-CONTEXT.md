# Phase 4 Context — Participant Profile

> Substrate phase for everything Phases 5-10 need: email address (for notifications), home airport (for personalised flights), optional budget + interests (for relevance filtering).

## Goal

Extend each participant's record beyond `{token, name}` to capture the personal context that downstream layers need to personalise output. No external APIs; pure DO + UI work.

## Decisions

### D-01 — Schema (DO + types)

New DO table `participant_profile`:

```sql
CREATE TABLE IF NOT EXISTS participant_profile (
  token            TEXT PRIMARY KEY,
  email            TEXT,                   -- optional but required for Phase 8+
  home_airport     TEXT,                   -- IATA 3-letter code, e.g. "MUC"
  home_city        TEXT,                   -- display string, e.g. "Munich"
  budget_max_eur   INTEGER,                -- nullable, € per person upper bound
  interests        TEXT,                   -- JSON-array string: ["museums", "food", ...]
  updated_at       INTEGER NOT NULL
);
```

Schema lives in `worker/durable-object.ts` — added to the existing `SCHEMA_DDL` constant. DO method `setProfile(token, profile)` / `getProfile(token)`.

TypeScript shape in `src/lib/profile.ts`:

```ts
export interface ParticipantProfile {
  email?: string;
  homeAirport?: string;   // IATA
  homeCity?: string;
  budgetMaxEur?: number;
  interests?: ProfileInterest[];
}

export type ProfileInterest =
  | 'museums' | 'outdoors' | 'food' | 'nightlife'
  | 'history' | 'festivals' | 'shopping' | 'beach';
```

### D-02 — Where profile data lives

**Crucially: NOT in `polls.json`.** That file is git-committed in template instances + lives in CF Pages env vars. Real participant emails would be a data leak. Profile lives only in the DO (encrypted at rest by Cloudflare, never leaves the worker).

`polls.json` keeps `{token, name}` only — same shape as today.

### D-03 — Onboarding UX

On first visit to `/<slug>/<token>/`:
1. Fetch `GET /api/poll?slug=X&token=Y` → response includes `viewer.profile` (could be `null`)
2. If `profile` is null OR `profile.email` is missing OR `profile.homeAirport` is missing:
   - Render `<ProfileForm />` ABOVE the calendar grid
   - Hide the grid until profile complete
3. If complete, just render the grid (existing flow)

Form fields:
- **Email** (required, type=email): "Where should we send the trip details?"
- **Home airport** (required, type=text with autocomplete from `src/data/airports.json`): "Where do you fly from?" — autocomplete shows "MUC — Munich Airport"
- **Budget cap** (optional, three-button group): "What's your per-person budget?" → €200 / €500 / €1000 / no limit
- **Interests** (optional, multi-check): "What kinds of things do you enjoy?" → 8 options

Submit → `POST /api/profile { slug, token, profile }` → on 200, reveal calendar grid.

### D-04 — Airport autocomplete data

Bundle `src/data/airports.json` — list of major airports with `{iata, name, city, country, traffic_rank}`. Source: OpenFlights database (public domain).

**Size budget:** full OpenFlights has ~10k airports = ~2MB. Tree-shake to top-200 by passenger traffic = ~30KB. Covers 99% of leisure-travel use cases.

Autocomplete implementation: vanilla JS, exact-prefix match on IATA code OR fuzzy match on city/name. No autocomplete library; ~40 lines of JS.

### D-05 — API surface additions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/profile` | participant token (body) | Set/update profile |
| GET | `/api/poll` (existing, extended) | participant token | Response now includes `viewer.profile` |
| GET | `/api/admin/poll` (existing, extended) | organiser token | Response includes `voterStatus[].profileComplete: boolean` |

Profile data NEVER appears in other-participant responses or public OG metadata.

### D-06 — Validation

Zod schema in `worker/lib/schemas.ts`:

```ts
const ProfileSchema = z.object({
  email: z.string().email().optional(),
  homeAirport: z.string().regex(/^[A-Z]{3}$/).optional(),
  homeCity: z.string().max(100).optional(),
  budgetMaxEur: z.number().int().positive().max(100000).optional(),
  interests: z.array(z.enum([...])).max(8).optional(),
});
```

Email validation: standard Zod; no MX-record check (out of scope).

### D-07 — Backward compat

Existing polls (no `participant_profile` rows yet) work fine:
- Phase 2 vote endpoints don't read profile → unaffected
- Phase 3 OG image generation doesn't read profile → unaffected
- New `viewer.profile` field is `null` until participant fills the form

No migration script needed — DDL is `CREATE TABLE IF NOT EXISTS`, table just appears empty for existing polls.

## What's intentionally NOT in this phase

- **Profile editing after first submission** — defer to Phase 8 (we'll add an "edit my profile" link in close-summary emails)
- **Email verification (double opt-in)** — overkill for friend-group use case; the email is only used to send THEM trip info, not to vouch for them publicly
- **Organiser bulk-importing emails** — organiser can edit `polls.json` to pre-fill `{token, name, email}` if they want; the DO profile just overrides if participant fills the form themselves
- **Phone numbers / SMS** — add only if email proves insufficient (Twilio adds cost; unlikely needed for friends)
- **Internationalization of airport names** — top-200 are mostly self-evident; defer

## Acceptance criteria

1. Participant page shows ProfileForm on first visit, calendar grid on subsequent visits (once email + airport set)
2. Autocomplete works: typing "Muni" suggests MUC; typing "MUC" auto-completes
3. Profile persists across browser quits + device changes (because it's DO-side, not localStorage)
4. Organiser dashboard shows "3/4 profiles complete" + a participant table column with ✓/✗ for each field
5. `POST /api/profile` validates inputs, rejects malformed (400)
6. `GET /api/poll` includes viewer's profile, NEVER another participant's
7. Existing Copenhagen-2026 demo poll still renders correctly (smoke test still 14/14)
