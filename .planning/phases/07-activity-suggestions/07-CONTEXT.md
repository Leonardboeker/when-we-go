# Phase 7 Context — Activity Suggestions (Claude API)

> Curated "things to do in <destination> during <date range>" via LLM with structured-output. One call per poll, cached aggressively.

## Goal

Surface 8-10 activities for the destination + date window. Two tiers: "happening this week" (time-bound — festivals, concerts) and "always great" (evergreen — museums, neighborhoods). Shared list, same for everyone.

## Decisions

### D-01 — API: Anthropic Claude

Model: `claude-3-5-haiku-latest` — fast, cheap, structured-output via `tools` API.

Why LLM not Google Places:
- "What's specifically happening in Copenhagen calendar week 28, 2026" is hard to query as structured data
- LLM reads multiple sources during inference, curates 8-10 items + a one-line "why"
- One API + one auth instead of integrating Google Places + Eventbrite + Foursquare
- Cost is negligible ($0.001/call)

### D-02 — Structured-output via tools API

Use the Claude `tools` parameter to force a specific JSON schema (no free-form prose to parse):

```ts
const tool = {
  name: 'submit_activities',
  description: 'Submit a curated activity list for the user.',
  input_schema: {
    type: 'object',
    properties: {
      thisWeek: {
        type: 'array',
        maxItems: 4,
        items: { /* see below */ }
      },
      alwaysGreat: {
        type: 'array',
        maxItems: 6,
        items: { /* see below */ }
      }
    },
    required: ['thisWeek', 'alwaysGreat']
  }
};

const itemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 80 },
    type: { type: 'string', enum: ['concert', 'festival', 'museum', 'food', 'outdoors', 'history', 'neighborhood', 'event', 'other'] },
    dateRange: { type: 'string', description: 'e.g. "all summer", "Jul 12-13", "Tuesdays only"' },
    paid: { type: 'boolean' },
    priceEur: { type: 'number', nullable: true },
    whyOneSentence: { type: 'string', maxLength: 160 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['name', 'type', 'dateRange', 'paid', 'whyOneSentence', 'confidence']
};
```

Request:

```ts
{
  model: 'claude-3-5-haiku-latest',
  max_tokens: 2000,
  tools: [tool],
  tool_choice: { type: 'tool', name: 'submit_activities' },
  messages: [{
    role: 'user',
    content: `You're suggesting activities for ${participants.length} people visiting ${destination} from ${start} to ${end}.

Return:
- Up to 4 "this week" items: events / festivals / openings happening specifically in this date range. Set confidence: 'high' if certain, 'low' if unsure (better to flag than guess).
- Up to 6 "always great" items: evergreen highlights (museums, neighborhoods, food spots).

Bias toward variety: mix indoor + outdoor, paid + free, food + culture.
Be honest about uncertainty — events specifically scheduled for a future date are often wrong; mark them confidence: low and let the user verify.

Call the submit_activities tool with your list.`
  }]
}
```

Response parsing: extract `content[0].input` (tool_use block) → that's our typed object directly.

### D-03 — Caching

Single cache key per slug: `activities:<slug>`. TTL 7 days (much longer than flights/hotels — activities are slow-moving).

### D-04 — Trigger points

1. **On close** (cron): fetch + cache
2. **Page load** (post-close): served from cache (fast)
3. **Manual refresh**: `POST /api/activities/refresh?slug=X` (organiser-token gated, rate-limit 1/day)

### D-05 — Confidence handling in UI

Each item has `confidence: 'high' | 'medium' | 'low'`. Render:
- `high` → no badge
- `medium` → small "ℹ verify dates" tooltip
- `low` → small "⚠ check current schedule" warning + dimmed background

This is the honest way to use LLM-curated event data without pretending it's authoritative.

### D-06 — API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/activities?slug=X&token=Y` | any valid token | Cached or fresh list |
| POST | `/api/activities/refresh?slug=X` | organiser | Force-refresh |

### D-07 — Error handling

| Scenario | Response |
|---|---|
| Missing `WHENWEGO_ANTHROPIC_API_KEY` | Return empty + reason `'not_configured'`. UI shows "Activity suggestions not configured." |
| Anthropic 5xx | Retry once; if still down, return cached (even stale); else empty + `'api_down'` |
| Tool-use response malformed | Should be impossible (Anthropic guarantees schema) but fallback: empty + `'parse_error'` log + alert organiser |
| Destination too obscure | Claude returns smaller list + acknowledges in `whyOneSentence`. UI just renders what came back. |
| Date range > 1 year in future | Claude tends to refuse specific events that far out. Acceptable — shows mostly "always great" items. |

### D-08 — Cost math

Per poll: ~1500 input tokens (prompt + schema) + ~1500 output tokens (10 items × ~150 tokens each). At Haiku pricing:
- Input: $0.80/M tokens → $0.0012/poll
- Output: $4.00/M tokens → $0.006/poll
- **Total: ~$0.007/poll**

$5 signup credit = ~700 polls before paying. After: still pennies.

### D-09 — Prompt safety

Inject `${destination}` etc. as parameters via the schema, not raw string interpolation in the user message. Reduces prompt-injection surface (organiser can't write malicious destinations that hijack the LLM).

## What's intentionally NOT in this phase

- Per-participant interest filtering — defer to Phase 7b if useful
- Booking links to GetYourGuide / Viator — adds affiliate complexity, defer
- Multi-LLM fallback (Claude down → OpenAI) — single provider for simplicity
- Image search for activities — pure-text output for now; LLM provides location names, user Googles for images
- Translation of activity output — English only

## Acceptance criteria

1. Post-close activity list cached + rendered
2. Two tiers visible: "this week" + "always great"
3. Confidence badges on uncertain items
4. Refresh works, rate-limit respected
5. Missing API key → graceful empty state
6. Real test: close a Copenhagen poll, verify the response includes plausible Copenhagen-specific suggestions
