// worker/handlers/admin-close.ts
// POST /api/admin/close?slug=X — force-close a poll (skip waiting for cron).
// Auth via X-Organizer-Token header (404 on wrong token, mirror admin-poll).
// Idempotent: already-closed polls return 200 { alreadyClosed: true }.
import type {
  Env,
  WhenWeGoPollDO,
  VoteRecord,
  ParticipantProfile,
} from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { computeOverlap, type VoteRow } from '../lib/overlap';
import { notifyPollClose } from '../lib/notify-pipeline';
import { fanOutCloseSummaryEmails } from '../lib/close-email-fanout';
import { computeTripStart } from '../lib/trip-date';
import { loadFlightsForParticipant } from './flights';
import { fanOutClosePush } from '../lib/push-fanout';

export async function handleAdminClose(
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

  const alreadyClosed = await stub.isClosed();
  if (alreadyClosed) {
    const closedAtRaw = await stub.getMeta('closed_at');
    const closedAtMs = closedAtRaw ? parseInt(closedAtRaw as string, 10) : null;
    return jsonResponse(
      {
        ok: true,
        alreadyClosed: true,
        closedAt: closedAtMs ? new Date(closedAtMs).toISOString() : null,
      },
      { status: 200 },
      req,
      env
    );
  }

  // Compute overlap fresh + persist + close.
  const allVotes = (await stub.getAllVotes()) as VoteRecord[];
  const overlap = computeOverlap(
    poll,
    allVotes.map((v) => ({ token: v.token, date: v.date, state: v.state })) as VoteRow[]
  );
  const { closedAt } = await stub.closeNow(JSON.stringify(overlap));

  // Phase 9: persist trip_start so the reminder cron can fire without
  // recomputing overlap on every tick. Empty string = no viable trip.
  // Poll passed as fallback (see trip-date.ts) — covers polls without
  // consensus by defaulting to poll.dateRangeStart.
  const tripStart = computeTripStart(overlap, poll);
  await stub.setMeta('trip_start', tripStart ?? '');

  // Mark notification as sent (idempotency for cron) + fire Telegram best-effort.
  await stub.setMeta('close_notified_at', String(closedAt));
  ctx.waitUntil(
    notifyPollClose(env, { pollSlug: poll.slug, overlap }).catch((err) => {
      console.error('[notify] pollClose rejected', err);
    })
  );

  // Phase 5: pre-fetch flights in parallel before the email fan-out so the
  // FLIGHTS section can populate. Safe-by-default: when Amadeus keys are
  // unset, loadFlightsForParticipant returns reason: 'not_configured'
  // synchronously without a network call.
  try {
    await Promise.allSettled(
      poll.participants.map((p) =>
        loadFlightsForParticipant({ env, poll, token: p.token })
      )
    );
  } catch (err) {
    console.error('[admin-close] flights pre-fetch failed', err);
  }

  // Phase 8: fan out per-participant close-summary emails (fire-and-forget).
  // sendEmail() silently skips when WHENWEGO_RESEND_API_KEY is unset, so this
  // is safe in Telegram-only deployments.
  const allProfiles = await stub.getAllProfiles();
  const profilesByToken = new Map(
    (allProfiles as Array<{ token: string } & ParticipantProfile>).map((p) => [
      p.token,
      p,
    ])
  );
  // Non-awaited (awaitAll:false) — each send goes through ctx.waitUntil inside.
  await fanOutCloseSummaryEmails({
    env,
    poll,
    overlap,
    profilesByToken,
    ctx,
    awaitAll: false,
  });

  // #9 — Web Push fan-out (best-effort, no-op without VAPID keys).
  ctx.waitUntil(
    fanOutClosePush({
      env,
      stub,
      poll,
      overlap,
      siteUrl: env.WHENWEGO_SITE_URL || 'https://when-we-go-demo.pages.dev',
    }).catch((err) => console.error('[admin-close] push fan-out failed', err))
  );

  return jsonResponse(
    {
      ok: true,
      alreadyClosed: false,
      closedAt: new Date(closedAt).toISOString(),
    },
    { status: 200 },
    req,
    env
  );
}
