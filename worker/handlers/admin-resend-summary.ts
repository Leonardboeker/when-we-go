// worker/handlers/admin-resend-summary.ts
// POST /api/admin/resend-close-summary?slug=X — re-fire close-summary emails for
// all participants with profile.email set. Useful when:
//   - Profiles were completed AFTER initial close (Phase 4 allows that)
//   - A participant updates their email and wants the summary again
//   - The first send failed for some participants
//
// Auth: X-Organizer-Token header; wrong token returns 404 (mirror Phase 2).
// The poll must already be closed (we won't pre-fire emails before close).
//
// Response shape: { ok: true, sent: N, skipped: M, errors: [...] }

import type {
  Env,
  WhenWeGoPollDO,
  VoteRecord,
  ParticipantProfile,
} from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { computeOverlap, type Overlap, type VoteRow } from '../lib/overlap';
import { fanOutCloseSummaryEmails } from '../lib/close-email-fanout';

export async function handleAdminResendSummary(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
  }
  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const [closedAtRaw, overlapCacheRaw, allVotes, allProfiles] = await Promise.all([
    stub.getMeta('closed_at'),
    stub.getMeta('overlap_cache'),
    stub.getAllVotes(),
    stub.getAllProfiles(),
  ]);

  if (!closedAtRaw) {
    return errorResponse(
      'Poll is not yet closed — close it first',
      400,
      req,
      env
    );
  }

  // Use cached overlap when present; recompute as fallback.
  let overlap: Overlap;
  if (overlapCacheRaw) {
    try {
      overlap = JSON.parse(overlapCacheRaw as string) as Overlap;
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

  const profilesByToken = new Map(
    (allProfiles as Array<{ token: string } & ParticipantProfile>).map((p) => [
      p.token,
      p,
    ])
  );

  // Build the queue + fire synchronously so we can report exact counts in the
  // response. (Unlike the close flow, this is admin-driven, not cron-driven —
  // small wait is acceptable.)
  const result = await fanOutCloseSummaryEmails({
    env,
    poll,
    overlap,
    profilesByToken,
    ctx,
    // Admin-initiated → await each send so the response includes per-send status.
    awaitAll: true,
  });

  return jsonResponse(
    {
      ok: true,
      sent: result.sent,
      skipped: result.skipped,
      errors: result.errors,
    },
    { status: 200 },
    req,
    env
  );
}
