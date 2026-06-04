// worker/lib/activities.ts
// Phase 7 — Activity Suggestions via Claude API (structured-output tools mode).
//
// One call per poll, cached aggressively (7d TTL). Two tiers:
//   thisWeek  — time-bound events during the trip dates (max 4)
//   alwaysGreat — evergreen highlights (museums, food, neighborhoods) (max 6)
//
// Each item has a `confidence` field so the UI can badge uncertain LLM claims.
// See CONTEXT D-02, D-05.

export type ActivityType =
  | 'concert'
  | 'festival'
  | 'museum'
  | 'food'
  | 'outdoors'
  | 'history'
  | 'neighborhood'
  | 'event'
  | 'other';

export type ActivityConfidence = 'high' | 'medium' | 'low';

export interface ActivityItem {
  name: string;
  type: ActivityType;
  /** e.g. "all summer", "Jul 12-13", "Tuesdays only", "year-round" */
  dateRange: string;
  paid: boolean;
  priceEur?: number | null;
  /** One sentence max (CONTEXT D-02 maxLength 160). */
  whyOneSentence: string;
  confidence: ActivityConfidence;
}

export type ActivitiesReason =
  | 'ok'
  | 'not_configured'
  | 'api_down'
  | 'parse_error';

export interface ActivitiesCachePayload {
  fetchedAt: number;
  reason: ActivitiesReason;
  thisWeek: ActivityItem[];
  alwaysGreat: ActivityItem[];
  destination: string;
  dateRange: { start: string; end: string };
}

/** Stable cache key for a given poll (single key shared — not per-participant). */
export function activitiesCacheKey(slug: string): string {
  return `activities:${slug}`;
}

/** Rate-limit lock key: if present, refresh is throttled for the rest of the day. */
export function activitiesRefreshLockKey(slug: string): string {
  return `activities_refresh_lock:${slug}`;
}

// ─── Claude tools schema ───────────────────────────────────────────────────

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 80 },
    type: {
      type: 'string',
      enum: [
        'concert',
        'festival',
        'museum',
        'food',
        'outdoors',
        'history',
        'neighborhood',
        'event',
        'other',
      ],
    },
    dateRange: {
      type: 'string',
      description: 'e.g. "all summer", "Jul 12-13", "Tuesdays only", "year-round"',
    },
    paid: { type: 'boolean' },
    priceEur: { type: 'number', nullable: true },
    whyOneSentence: { type: 'string', maxLength: 160 },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  required: ['name', 'type', 'dateRange', 'paid', 'whyOneSentence', 'confidence'],
} as const;

const SUBMIT_ACTIVITIES_TOOL = {
  name: 'submit_activities',
  description: 'Submit a curated activity list for the group trip.',
  input_schema: {
    type: 'object',
    properties: {
      thisWeek: {
        type: 'array',
        description:
          'Time-bound events / festivals / openings happening specifically during the trip dates.',
        maxItems: 4,
        items: ITEM_SCHEMA,
      },
      alwaysGreat: {
        type: 'array',
        description:
          'Evergreen highlights: museums, neighborhoods, food spots — available any time.',
        maxItems: 6,
        items: ITEM_SCHEMA,
      },
    },
    required: ['thisWeek', 'alwaysGreat'],
  },
};

// ─── API call ─────────────────────────────────────────────────────────────

export async function fetchActivitiesFromClaude(args: {
  apiKey: string;
  destination: string;
  dateStart: string;
  dateEnd: string;
  participantCount: number;
}): Promise<{ result: { thisWeek: ActivityItem[]; alwaysGreat: ActivityItem[] } | null; reason: ActivitiesReason }> {
  const { apiKey, destination, dateStart, dateEnd, participantCount } = args;

  const prompt =
    `You're suggesting activities for a group of ${participantCount} people visiting ${destination} from ${dateStart} to ${dateEnd}.\n\n` +
    `Return:\n` +
    `- Up to 4 "thisWeek" items: events / festivals / openings happening specifically during these dates. ` +
    `Set confidence: 'high' if certain, 'low' if unsure — better to flag than guess.\n` +
    `- Up to 6 "alwaysGreat" items: evergreen highlights (museums, neighborhoods, food spots).\n\n` +
    `Bias toward variety: mix indoor + outdoor, paid + free, food + culture.\n` +
    `Be honest about uncertainty — future-dated events are often wrong; mark them low confidence.\n\n` +
    `Call the submit_activities tool with your list.`;

  let resp: Response;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 2000,
        tools: [SUBMIT_ACTIVITIES_TOOL],
        tool_choice: { type: 'tool', name: 'submit_activities' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    console.error('[activities] network error calling Anthropic', err);
    return { result: null, reason: 'api_down' };
  }

  if (!resp.ok) {
    console.error('[activities] Anthropic API HTTP error', resp.status, await resp.text().catch(() => ''));
    return { result: null, reason: 'api_down' };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { result: null, reason: 'parse_error' };
  }

  try {
    const content = (body as { content?: Array<{ type: string; input?: unknown }> }).content ?? [];
    const toolBlock = content.find((c) => c.type === 'tool_use');
    if (!toolBlock || !toolBlock.input) {
      console.error('[activities] no tool_use block in response');
      return { result: null, reason: 'parse_error' };
    }
    const input = toolBlock.input as { thisWeek?: ActivityItem[]; alwaysGreat?: ActivityItem[] };
    return {
      result: {
        thisWeek: Array.isArray(input.thisWeek) ? input.thisWeek : [],
        alwaysGreat: Array.isArray(input.alwaysGreat) ? input.alwaysGreat : [],
      },
      reason: 'ok',
    };
  } catch (err) {
    console.error('[activities] parse error', err);
    return { result: null, reason: 'parse_error' };
  }
}
