# Phase 4 Plan — Participant Profile

> Atomic tasks for Phase 4. CONTEXT in same dir. All paths relative to `D:/dev/when-we-go/`.

## Tasks

### T-01 — DO schema extension
**File:** `worker/durable-object.ts`

Add `CREATE TABLE IF NOT EXISTS participant_profile (...)` to existing `SCHEMA_DDL`. Add typed methods:
- `setProfile(token: string, profile: ParticipantProfile): void`
- `getProfile(token: string): ParticipantProfile | null`
- `getAllProfiles(): Array<{token: string} & ParticipantProfile>`  (admin view)

Use upsert semantics: `INSERT OR REPLACE INTO participant_profile (...)`.

### T-02 — Types + Zod schemas
**Files:** `src/lib/profile.ts` (new), `worker/lib/schemas.ts` (extend)

Export `ParticipantProfile` type + `ProfileInterest` enum (8 values). Zod schema with email regex, IATA regex, max bounds.

### T-03 — `POST /api/profile` endpoint
**Files:** `worker/handlers/profile.ts` (new), wire into `worker/index.ts`

Validate body via `ProfileRequestSchema`. Resolve slug → token → DO. Reject if poll closed (we still allow profile updates post-close — they're needed for proposals/reminders). Call DO `setProfile`. Return `{ ok, profileComplete: bool }`.

### T-04 — Extend `GET /api/poll` response
**Files:** `worker/handlers/poll.ts`

Add `viewer.profile: ParticipantProfile | null` to existing response. Never include other participants' profiles.

### T-05 — Extend `GET /api/admin/poll` response
**Files:** `worker/handlers/admin-poll.ts`

Add `voterStatus[].profileComplete: boolean` (email + homeAirport both set). Don't expose actual emails/airports — only completeness boolean.

### T-06 — Airport autocomplete data
**Files:** `src/data/airports.json` (new)

Top 200 airports by passenger traffic. Each `{iata, name, city, country}`. Source: OpenFlights public-domain DB, manually pre-filtered.

Generate via a small build-time script `scripts/gen-airports.mjs` that reads from a bundled list (commit the list directly so adopters don't need internet).

For night-execution efficiency: write 200 hand-picked entries directly (top European + American + Asian hubs — cover 99% of leisure-trip origins).

### T-07 — `<ProfileForm />` Astro component
**Files:** `src/components/ProfileForm.astro` (new)

- Server-rendered HTML form
- 4 fields: email (input type=email), home airport (input type=text + autocomplete), budget (radio: 200/500/1000/no-limit), interests (8 checkboxes)
- Autocomplete: vanilla JS in the form's `<script>` block, reads from bundled `airports.json`, shows top 5 matches on input
- Submit handler: `fetch('/api/profile', POST, {slug, token, profile})` → on 200, hide form + reveal grid

Form is initially `hidden` if profile complete; visible if profile incomplete.

### T-08 — Wire into `[slug]/[token].astro`
**Files:** `src/pages/[slug]/[token].astro`

After page load, the existing IIFE (which fetches `/api/poll`) now also checks `viewer.profile`. If incomplete, show `<ProfileForm />`, hide `<CalendarGrid />`. If complete, hide form, show grid.

### T-09 — Admin dashboard: profile-complete indicator
**Files:** `src/pages/[slug]/admin/[token].astro`

Voter status table gets new column "Profile" with ✓ / ✗. Show "N/4 profiles complete" summary above.

### T-10 — Smoke test extension
**Files:** `scripts/smoke-test.mjs`

Add checks:
- `POST /api/profile` with valid body → 200
- `POST /api/profile` with invalid email → 400
- `POST /api/profile` with invalid IATA → 400
- `GET /api/poll` after profile set → response includes `viewer.profile`
- `GET /api/admin/poll` → `voterStatus[].profileComplete` boolean present

### T-11 — Build verify + smoke
**Files:** none

1. `npm run build` → still produces 7+ static pages
2. `node scripts/verify-isolation.mjs` → exit 0
3. `node --test worker/lib/overlap.test.ts` → still 8/8
4. `npx wrangler deploy --dry-run` → still compiles
5. `wrangler dev` + smoke → all old 14 checks pass + new ~5 profile checks pass

## Acceptance

- New participant page shows ProfileForm if profile null/incomplete
- Returning participant page shows grid directly
- Autocomplete returns top-5 matches on typing "Mun" → MUC suggested
- Admin sees per-participant ✓/✗
- `viewer.profile` privacy: only own profile in `/api/poll` response
- All previous smoke checks still pass
