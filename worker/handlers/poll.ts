// worker/handlers/poll.ts
// GET /api/poll?slug=X&token=Y — return viewer's votes + poll meta.
// Post-close, also include the cached overlap.
import type { Env, WhenWeGoPollDO, VoteRecord } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateParticipantToken } from '../lib/polls-config';
import type { Overlap } from '../lib/overlap';

export async function handlePoll(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (!slug || !token) {
    return errorResponse('Missing slug or token', 400, req, env);
  }

  const poll = findPoll(env, slug);
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }
  const participant = validateParticipantToken(poll, token);
  if (!participant) {
    return errorResponse('Invalid token', 401, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // history (stub.getVoterStatus) was used for vote_history.vote_count, but
  // that counted click actions, not live votes. We compute the real per-token
  // count from allVotes below; keep getVoterStatus out of the parallel fetch.
  const [votes, closedAtRaw, overlapCacheRaw, profile, comments, allVotes] = await Promise.all([
    stub.getVotesForToken(token),
    stub.getMeta('closed_at'),
    stub.getMeta('overlap_cache'),
    stub.getProfile(token),
    stub.getComments(), // #6
    stub.getAllVotes(), // Phase 11: live group availability + voterStatus source
  ]);

  const closed = closedAtRaw !== null;
  const closedAtMs = closed ? parseInt(closedAtRaw as string, 10) : null;
  const closedAtIso = closedAtMs ? new Date(closedAtMs).toISOString() : null;

  let overlap: Overlap | null = null;
  if (closed && overlapCacheRaw) {
    try {
      overlap = JSON.parse(overlapCacheRaw as string) as Overlap;
    } catch {
      overlap = null;
    }
  }

  // Build a voterStatus summary: one entry per participant, with voteCount.
  // BUG FIX: vote_history.vote_count counts CLICK ACTIONS (set + unset both
  // increment), so a participant who tapped a day and untapped it shows as
  // "voted" even though they have no live vote. The UI's "X von 4 haben
  // abgestimmt" must reflect ACTUAL engagement — count their live yes/maybe
  // entries instead. (Keep "voteCount" name for API compat.) We still only
  // expose the count, not dates/states.
  const liveCountByToken = new Map<string, number>();
  for (const v of allVotes as VoteRecord[]) {
    if (v.state === 'yes' || v.state === 'maybe') {
      liveCountByToken.set(v.token, (liveCountByToken.get(v.token) ?? 0) + 1);
    }
  }
  const voterStatus = poll.participants.map((p) => ({
    name: p.name,
    voteCount: liveCountByToken.get(p.token) ?? 0,
  }));

  // Phase 11: live group availability — every participant's vote per day, by
  // NAME only (tokens are never exposed). Lets each viewer see who can make it
  // on which day while the poll is still open. Deliberate transparency for the
  // family-poll use case (user-confirmed).
  const nameByToken = new Map(poll.participants.map((p) => [p.token, p.name]));
  const groupVotes: Record<string, Array<{ name: string; state: string }>> = {};
  for (const v of allVotes as VoteRecord[]) {
    const name = nameByToken.get(v.token);
    if (!name) continue; // skip votes from removed/unknown tokens
    (groupVotes[v.date] ??= []).push({ name, state: v.state });
  }

  return jsonResponse(
    {
      poll: {
        slug: poll.slug,
        title: poll.title,
        destination: poll.destination,
        dateRangeStart: poll.dateRangeStart,
        dateRangeEnd: poll.dateRangeEnd,
        pollCloseAt: poll.pollCloseAt,
        participantCount: poll.participants.length,
      },
      viewer: {
        name: participant.name,
        // Same bug fix: live count of yes/maybe, not history clicks.
        voteCount: liveCountByToken.get(token) ?? 0,
        // Phase 4: own profile only — NEVER include other participants' profiles.
        profile: profile ?? null,
      },
      votes: (votes as VoteRecord[]).map((v) => ({
        date: v.date,
        state: v.state,
      })),
      voterStatus,
      groupVotes, // Phase 11: per-day votes by name (no tokens)
      closed,
      closedAt: closedAtIso,
      overlap,
      // #6 — date comments (no token exposed; name + date + text + own flag).
      comments: (comments as Array<{ token: string; name: string; date: string; text: string; createdAt: number }>).map((c) => ({
        name: c.name,
        date: c.date,
        text: c.text,
        createdAt: c.createdAt,
        isMine: c.token === token,
      })),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
