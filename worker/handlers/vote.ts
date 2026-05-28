// worker/handlers/vote.ts
// POST /api/vote — bulk-replace a participant's votes for one poll.
// Body: { slug, token, votes: [{ date, state }] }
// Returns 200 { ok, voteCount } on success, error JSON otherwise.
import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { VoteRequestSchema } from '../lib/schemas';
import {
  dateInRange,
  findPoll,
  validateParticipantToken,
} from '../lib/polls-config';
import { notifyFirstVote } from '../lib/notify-pipeline';

export async function handleVote(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req, env);
  }
  const parsed = VoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('Invalid request', 400, req, env);
  }
  const { slug, token, votes } = parsed.data;

  const poll = findPoll(env, slug);
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }
  const participant = validateParticipantToken(poll, token);
  if (!participant) {
    return errorResponse('Invalid token', 401, req, env);
  }

  // Reject any out-of-range dates BEFORE touching the DO.
  for (const v of votes) {
    if (!dateInRange(poll, v.date)) {
      return errorResponse(
        `Date ${v.date} outside poll range ${poll.dateRangeStart}..${poll.dateRangeEnd}`,
        400,
        req,
        env
      );
    }
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // Reject if already closed.
  const closed = await stub.isClosed();
  if (closed) {
    return errorResponse('Poll is closed', 410, req, env);
  }

  const { voteCount, wasFirstVote } = await stub.castVotes(token, votes);

  if (wasFirstVote) {
    // Fire-and-forget — never block the API response on Telegram.
    const voterStatus = await stub.getVoterStatus();
    ctx.waitUntil(
      notifyFirstVote(env, {
        pollSlug: poll.slug,
        voterName: participant.name,
        votedSoFar: voterStatus.length,
        totalParticipants: poll.participants.length,
      }).catch((err) => {
        console.error('[notify] firstVote rejected', err);
      })
    );
  }

  return jsonResponse({ ok: true, voteCount }, { status: 200 }, req, env);
}
