// worker/handlers/admin-close.ts
// POST /api/admin/close?slug=X — force-close a poll (skip waiting for cron).
// Auth via X-Organizer-Token header (404 on wrong token, mirror admin-poll).
// Idempotent: already-closed polls return 200 { alreadyClosed: true }.
import type { Env, WhenWeGoPollDO, VoteRecord } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { computeOverlap, type VoteRow } from '../lib/overlap';
import { notifyPollClose } from '../lib/notify-pipeline';

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

  // Mark notification as sent (idempotency for cron) + fire Telegram best-effort.
  await stub.setMeta('close_notified_at', String(closedAt));
  ctx.waitUntil(
    notifyPollClose(env, { pollSlug: poll.slug, overlap }).catch((err) => {
      console.error('[notify] pollClose rejected', err);
    })
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
