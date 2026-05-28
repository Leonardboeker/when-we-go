// worker/handlers/admin-poll.ts
// GET /api/admin/poll?slug=X — aggregate per-date breakdown + voter status + overlap.
// Auth via X-Organizer-Token header. Wrong/missing token → 404 (slug-enumeration
// protection, mirrors pay-me-back's admin-route hardening).
import type {
  Env,
  WhenWeGoPollDO,
  VoteRecord,
  VoterStatusRow,
  ParticipantProfile,
} from '../durable-object';
import { isProfileComplete } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { computeOverlap, type Overlap, type VoteRow } from '../lib/overlap';

export async function handleAdminPoll(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
  }
  const poll = findPoll(env, slug);
  // 404 (not 401) on both missing poll AND wrong org-token to prevent slug enumeration.
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const [allVotes, voterStatus, closedAtRaw, cachedOverlapRaw, allProfiles] = await Promise.all([
    stub.getAllVotes(),
    stub.getVoterStatus(),
    stub.getMeta('closed_at'),
    stub.getMeta('overlap_cache'),
    stub.getAllProfiles(),
  ]);

  const closed = closedAtRaw !== null;
  const closedAtMs = closed ? parseInt(closedAtRaw as string, 10) : null;
  const closedAtIso = closedAtMs ? new Date(closedAtMs).toISOString() : null;

  // Use cached overlap when closed (cheaper + deterministic); recompute live otherwise.
  let overlap: Overlap;
  if (closed && cachedOverlapRaw) {
    try {
      overlap = JSON.parse(cachedOverlapRaw as string) as Overlap;
    } catch {
      overlap = computeOverlap(
        poll,
        (allVotes as VoteRecord[]).map((v) => ({
          token: v.token,
          date: v.date,
          state: v.state,
        })) as VoteRow[]
      );
    }
  } else {
    overlap = computeOverlap(
      poll,
      (allVotes as VoteRecord[]).map((v) => ({
        token: v.token,
        date: v.date,
        state: v.state,
      })) as VoteRow[]
    );
  }

  // Build voter status — join with poll.participants for names.
  const statusByToken = new Map(
    (voterStatus as VoterStatusRow[]).map((s) => [s.token, s])
  );
  // Phase 4: index profiles by token for the profileComplete flag.
  // We expose only the boolean — the actual email/airport stay DO-side
  // (privacy: organiser doesn't need to see participants' personal data).
  const profileByToken = new Map(
    (allProfiles as Array<{ token: string } & ParticipantProfile>).map((p) => [
      p.token,
      p,
    ])
  );
  const voterRows = poll.participants.map((p) => {
    const s = statusByToken.get(p.token);
    const prof = profileByToken.get(p.token);
    return {
      name: p.name,
      token: p.token,
      hasVoted: !!s,
      firstVotedAt: s?.first_voted_at ?? null,
      lastVotedAt: s?.last_voted_at ?? null,
      voteCount: s?.vote_count ?? 0,
      profileComplete: isProfileComplete(prof ?? null),
    };
  });

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
      voterStatus: voterRows,
      overlap,
      closed,
      closedAt: closedAtIso,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
