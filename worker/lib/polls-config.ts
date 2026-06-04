// worker/lib/polls-config.ts
// Pure helpers around WHENWEGO_POLLS_JSON env secret. No DO / Worker deps.
// Mirrors pay-me-back's prebuild-style hard-fail: bad JSON throws synchronously
// so the Worker surface crashes loudly instead of returning silent 500s.

export interface Participant {
  token: string;
  name: string;
}

export interface Poll {
  slug: string;
  title: string;
  destination?: string;
  dateRangeStart: string; // ISO YYYY-MM-DD
  dateRangeEnd: string;   // ISO YYYY-MM-DD
  pollCloseAt: string;    // ISO with TZ offset
  /** Optional: deadline for hotel + activity voting. ISO date string. */
  hotelVoteDeadline?: string;
  organizerToken: string;
  participants: Participant[];
  createdAt: string;
}

export interface PollsConfigEnv {
  WHENWEGO_POLLS_JSON?: string;
}

// Cache per-isolate so we don't reparse on every request (Worker isolates are
// long-lived; JSON.parse is cheap but not free at 100 req/s).
let cached: { raw: string; polls: Poll[] } | null = null;

export function loadPolls(env: PollsConfigEnv): Poll[] {
  const raw = env.WHENWEGO_POLLS_JSON;
  if (!raw) {
    throw new Error('WHENWEGO_POLLS_JSON env var is unset');
  }
  if (cached && cached.raw === raw) {
    return cached.polls;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `WHENWEGO_POLLS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('WHENWEGO_POLLS_JSON must be a JSON array');
  }
  const polls = parsed as Poll[];
  // Light shape validation (no zod here — keep this dep-free for cron callsite).
  for (const p of polls) {
    if (typeof p.slug !== 'string' || !p.slug) {
      throw new Error('WHENWEGO_POLLS_JSON: poll missing slug');
    }
    if (!Array.isArray(p.participants)) {
      throw new Error(`WHENWEGO_POLLS_JSON: poll ${p.slug} missing participants array`);
    }
  }
  cached = { raw, polls };
  return polls;
}

export function findPoll(env: PollsConfigEnv, slug: string): Poll | null {
  try {
    const polls = loadPolls(env);
    return polls.find((p) => p.slug === slug) ?? null;
  } catch {
    return null;
  }
}

export function validateParticipantToken(
  poll: Poll,
  token: string
): Participant | null {
  return poll.participants.find((p) => p.token === token) ?? null;
}

export function validateOrganizerToken(poll: Poll, token: string): boolean {
  return poll.organizerToken === token;
}

// Inclusive on both ends. Pure string compare works because dates are ISO.
export function dateInRange(poll: Poll, date: string): boolean {
  return date >= poll.dateRangeStart && date <= poll.dateRangeEnd;
}
