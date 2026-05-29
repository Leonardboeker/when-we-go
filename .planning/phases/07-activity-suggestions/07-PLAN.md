# Phase 7 Plan — Activity Suggestions (Claude API, REAL)

> Anthropic Claude Haiku via structured-output (tools API). Real key in `.dev.vars`. Two tiers: time-bound ("this week") + evergreen ("always great") with confidence badges.
> All paths relative to `D:/dev/when-we-go/`.

## Tasks

### T-01 — Claude API client
**Files:** `worker/lib/claude.ts` (new)

```ts
export async function claudeStructured<T>({
  apiKey,
  model = 'claude-3-5-haiku-latest',
  maxTokens = 2000,
  systemPrompt,
  userMessage,
  tool,        // { name, description, input_schema }
  timeoutMs = 30_000
}): Promise<{ ok: true; data: T } | { ok: false; error: string }>
```

- POST `https://api.anthropic.com/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01`
- `tool_choice: { type: 'tool', name: tool.name }` forces JSON output
- Parse `content[0].input` if `content[0].type === 'tool_use'`
- AbortController for timeout
- Returns typed payload OR `{ ok: false, error: string }`

### T-02 — Activity schema + provider
**Files:** `worker/lib/activity-provider.ts` (new)

```ts
export interface ActivityItem {
  name: string;
  type: 'concert' | 'festival' | 'museum' | 'food' | 'outdoors' | 'history' | 'neighborhood' | 'event' | 'other';
  dateRange: string;
  paid: boolean;
  priceEur?: number;
  whyOneSentence: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ActivityList {
  thisWeek: ActivityItem[];
  alwaysGreat: ActivityItem[];
}

export interface ActivityProvider {
  readonly name: string;
  readonly isReal: boolean;
  fetchActivities(input: { destination: string; startDate: string; endDate: string; participantCount: number }): Promise<ActivityList>;
}
```

Two providers:
- `ClaudeActivityProvider` (uses claude.ts) — real, requires `WHENWEGO_ANTHROPIC_API_KEY`
- `MockActivityProvider` — deterministic, returns 8-10 plausible items per destination

Factory: `getActivityProvider(env)` — uses ClaudeActivityProvider if key set, else mock.

### T-03 — Mock activity provider
**Files:** `worker/lib/activity-provider-mock.ts` (new)

Hash-seeded mock with hand-curated "evergreen highlights per destination" lookup table (top 30 destinations have real-named museums/neighborhoods; rest get generic templates). All items marked confidence:'high' for evergreens, 'medium' for "this week" (since these are fabricated).

Source field on each item: extend ActivityItem with `source?: 'mock' | 'claude'` for UI/banner purposes.

### T-04 — Claude prompt + tool definition
**Files:** `worker/lib/activity-provider-claude.ts` (new)

System prompt: "You're suggesting activities for a small group visiting a destination. Be honest about uncertainty — for events specifically scheduled for a future date, prefer confidence:'low' and let users verify themselves."

User message: "Group of <N> people visiting <destination> from <start> to <end>. Suggest up to 4 'this week' items (time-bound: concerts/festivals/exhibitions opening) and up to 6 'always great' evergreen items (museums, neighborhoods, food). Mix indoor + outdoor, paid + free, food + culture."

Tool input schema: arrays per CONTEXT D-02. Use Claude's `input_schema` JSON-schema validation.

### T-05 — Activity endpoints
**Files:**
- `worker/handlers/activities.ts` — `GET /api/activities?slug=X&token=Y` (any valid token)
- `worker/handlers/activities-refresh.ts` — `POST /api/activities/refresh?slug=X` (org only, 1/day limit)

Response shape:
```ts
{
  fetchedAt: number;
  activities: ActivityList;
  reason: 'ok' | 'destination_too_obscure' | 'provider_error';
  provider: { name: string; isReal: boolean };
}
```

Cache key: `activities:<slug>:<startDate>:<endDate>:<providerName>` TTL 7 days (activities slow-moving).

### T-06 — Cron + email integration
**Files:** `worker/scheduled.ts`, `worker/lib/close-email-fanout.ts`, `worker/lib/reminder-fanout.ts`

On close: fetch activities (1 call per poll, shared), cache, pass to close-summary email.
On T-7 reminder: re-use cached activities (no re-fetch — 7d TTL covers reminder window typically).

### T-07 — Email template integration
**Files:** `worker/lib/email-templates.ts`

`renderCloseSummaryEmail` accepts `activities?` per Phase 8. Render two sections:
- "Happening this week" (with confidence badges: high=no badge, medium="ℹ verify", low="⚠ check schedule")
- "Always great"

If `provider.isReal === false`, add "DEMO activities" note.

### T-08 — Participant page integration
**Files:** `src/pages/[slug]/[token].astro`, `src/components/ActivitiesList.astro` (new)

Post-close render component:
- Two sections with type-icons (🎵 🎨 🏛️ 🍽️ 🌳 🏰 🏘️ 🎉 🔮)
- Confidence badges on uncertain items
- DEMO banner if provider.isReal === false
- Refresh button (org only, gated)

### T-09 — Smoke test extension
Add ~4 checks:
- `GET /api/activities?slug=X&token=Y` → 200, activities.thisWeek/alwaysGreat present, provider.isReal === true (since real key in .dev.vars)
- Cached call returns same fetchedAt
- `POST /api/activities/refresh` org → 200, new fetchedAt
- Wrong org → 404

### T-10 — Build + verify
1. `npm run build` → 7+ pages
2. `verify-isolation` → exit 0
3. Existing unit tests pass
4. NEW: `node --test worker/lib/activity-provider-mock.test.ts` → ≥3 tests
5. `wrangler deploy --dry-run` → clean
6. `wrangler dev` + smoke → 49 existing + ~4 new = 53+ pass

**Real Claude integration test:** the smoke test for `/api/activities` against the Copenhagen poll should succeed with `provider.isReal === true` and return plausible Copenhagen-themed items (Tivoli, Nyhavn, etc.) since real key is configured.

## Acceptance

- Activity list appears post-close, two tiers
- Real Claude integration verified (smoke test confirms `provider.isReal === true`, response includes plausible Copenhagen-themed items)
- Confidence badges on uncertain items
- Refresh works, rate-limit respected
- Phase 6 + earlier smoke tests still green
