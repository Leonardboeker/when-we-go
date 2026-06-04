// worker/handlers/admin-reopen.ts
// #8 — POST /api/admin/reopen?slug=X&days=N — reopen a closed poll for N more
// days (default 7). Organiser-only (X-Organizer-Token). Clears the close state
// and sets a future close override so the cron won't immediately re-close.
import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';

export async function handleAdminReopen(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) return errorResponse('Missing slug', 400, req, env);
  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  // Days to extend (1..60, default 7).
  let days = parseInt(url.searchParams.get('days') ?? '7', 10);
  if (!Number.isFinite(days)) days = 7;
  days = Math.min(60, Math.max(1, days));
  const newCloseAtMs = Date.now() + days * 24 * 60 * 60 * 1000;

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  await stub.reopen(newCloseAtMs);

  return jsonResponse(
    {
      ok: true,
      reopened: true,
      newCloseAt: new Date(newCloseAtMs).toISOString(),
      days,
    },
    { status: 200 },
    req,
    env
  );
}
