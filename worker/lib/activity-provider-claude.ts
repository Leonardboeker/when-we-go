// worker/lib/activity-provider-claude.ts
// Phase 7 — real Claude-backed activity provider.
//
// Uses claudeStructured<ActivityList>() to force a typed JSON shape out of
// Haiku via Anthropic's `tools` API (see CONTEXT D-02). The model's response
// is the tool_use payload directly — no prose parsing.
//
// Failure modes downgrade gracefully:
//   - missing apiKey at construction       → would never happen (factory guards)
//   - network / 5xx / timeout              → reason: 'provider_error', empty list
//   - destination too obscure for Claude   → typically returns small list (ok)
//
// `source: 'claude'` is stamped on every returned item so the UI can choose
// not to flag DEMO. `confidence` is whatever Claude self-reported.

import type {
  ActivityItem,
  ActivityList,
  ActivityProvider,
  ActivitySearchInput,
  ActivitySearchResult,
  ActivityType,
  ActivityConfidence,
} from './activity-provider.ts';
import { claudeStructured, type ClaudeToolDef } from './claude.ts';

const ACTIVITY_TYPES: ActivityType[] = [
  'concert',
  'festival',
  'museum',
  'food',
  'outdoors',
  'history',
  'neighborhood',
  'event',
  'other',
];

const CONFIDENCE_VALUES: ActivityConfidence[] = ['high', 'medium', 'low'];

/** JSONSchema for a single ActivityItem — matches CONTEXT D-02 exactly. */
const itemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 80 },
    type: { type: 'string', enum: ACTIVITY_TYPES },
    dateRange: {
      type: 'string',
      description: 'e.g. "all summer", "Jul 12-13", "Tuesdays only"',
    },
    paid: { type: 'boolean' },
    priceEur: { type: ['number', 'null'] },
    whyOneSentence: { type: 'string', maxLength: 160 },
    confidence: { type: 'string', enum: CONFIDENCE_VALUES },
  },
  required: [
    'name',
    'type',
    'dateRange',
    'paid',
    'whyOneSentence',
    'confidence',
  ],
};

const submitActivitiesTool: ClaudeToolDef = {
  name: 'submit_activities',
  description: 'Submit a curated activity list for the user.',
  input_schema: {
    type: 'object',
    properties: {
      thisWeek: { type: 'array', maxItems: 4, items: itemSchema },
      alwaysGreat: { type: 'array', maxItems: 6, items: itemSchema },
    },
    required: ['thisWeek', 'alwaysGreat'],
  },
};

const SYSTEM_PROMPT =
  "You're suggesting activities for a small group visiting a destination. " +
  'Be honest about uncertainty — for events specifically scheduled for a future date, ' +
  "prefer confidence:'low' and let users verify themselves. " +
  'Bias toward variety: mix indoor + outdoor, paid + free, food + culture. ' +
  'Always call the submit_activities tool — never reply in plain prose.';

/** Build the user-turn message from the search input. */
function buildUserMessage(input: ActivitySearchInput): string {
  return [
    `Group of ${input.participantCount} people visiting ${input.destination} ` +
      `from ${input.startDate} to ${input.endDate}.`,
    '',
    'Return:',
    '- Up to 4 "thisWeek" items: events / festivals / openings happening specifically in this date range. ' +
      "Set confidence:'high' only if you're certain it's running on these dates; 'low' if guessing.",
    '- Up to 6 "alwaysGreat" items: evergreen highlights (museums, neighborhoods, food spots).',
    '',
    'Bias toward variety: mix indoor + outdoor, paid + free, food + culture.',
    'Be honest about uncertainty — events specifically scheduled for a future date are often wrong; ' +
      "mark them confidence: 'low' and let the user verify.",
    '',
    'Call the submit_activities tool with your list.',
  ].join('\n');
}

/**
 * Coerce / sanitise an item returned by Claude — even with input_schema
 * enforced, defensive checks (clamping enums, dropping bad rows) make sure a
 * weird payload doesn't poison the cache.
 */
function sanitiseItem(raw: unknown): ActivityItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name) return null;
  const typeVal = typeof r.type === 'string' ? (r.type as string) : '';
  const type: ActivityType = (ACTIVITY_TYPES as string[]).includes(typeVal)
    ? (typeVal as ActivityType)
    : 'other';
  if (typeof r.dateRange !== 'string') return null;
  if (typeof r.whyOneSentence !== 'string') return null;
  const confVal = typeof r.confidence === 'string' ? (r.confidence as string) : '';
  const confidence: ActivityConfidence = (CONFIDENCE_VALUES as string[]).includes(
    confVal
  )
    ? (confVal as ActivityConfidence)
    : 'low';
  const paid = r.paid === true;
  let priceEur: number | null = null;
  if (typeof r.priceEur === 'number' && Number.isFinite(r.priceEur)) {
    priceEur = r.priceEur;
  }
  return {
    name: r.name.slice(0, 80),
    type,
    dateRange: r.dateRange.slice(0, 80),
    paid,
    priceEur,
    whyOneSentence: r.whyOneSentence.slice(0, 200),
    confidence,
    source: 'claude',
  };
}

function sanitiseList(raw: unknown): ActivityList {
  const empty: ActivityList = { thisWeek: [], alwaysGreat: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const thisWeek = Array.isArray(r.thisWeek)
    ? (r.thisWeek as unknown[])
        .map(sanitiseItem)
        .filter((x): x is ActivityItem => x !== null)
        .slice(0, 4)
    : [];
  const alwaysGreat = Array.isArray(r.alwaysGreat)
    ? (r.alwaysGreat as unknown[])
        .map(sanitiseItem)
        .filter((x): x is ActivityItem => x !== null)
        .slice(0, 6)
    : [];
  return { thisWeek, alwaysGreat };
}

export class ClaudeActivityProvider implements ActivityProvider {
  readonly name = 'claude';
  readonly isReal = true;

  constructor(private readonly apiKey: string) {}

  async fetchActivities(
    input: ActivitySearchInput
  ): Promise<ActivitySearchResult> {
    if (!input.destination) {
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'destination_too_obscure',
      };
    }

    const result = await claudeStructured<ActivityList>({
      apiKey: this.apiKey,
      // Haiku 4.5 — the 3-5-haiku-latest alias is deprecated by Anthropic.
      model: 'claude-haiku-4-5',
      maxTokens: 2000,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: buildUserMessage(input),
      tool: submitActivitiesTool,
      timeoutMs: 30_000,
    });

    if (!result.ok) {
      console.error(`[activities] claude provider error: ${result.error}`);
      return {
        activities: { thisWeek: [], alwaysGreat: [] },
        reason: 'provider_error',
      };
    }

    const activities = sanitiseList(result.data);
    if (activities.thisWeek.length + activities.alwaysGreat.length === 0) {
      return { activities, reason: 'destination_too_obscure' };
    }
    return { activities, reason: 'ok' };
  }
}
