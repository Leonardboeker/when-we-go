// worker/handlers/admin-data.ts
// #5 (DSGVO / GDPR) — organiser-only data export + irreversible wipe.
//   GET  /api/admin/export?slug=X         → JSON dump of all stored data
//   POST /api/admin/wipe?slug=X&confirm=DELETE → delete everything (post-trip)
// Both gated by X-Organizer-Token (404 on mismatch, mirroring the other admin
// endpoints). The wipe requires an explicit confirm=DELETE query param so an
// accidental POST can't nuke real data.
import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';

function authedStub(req: Request, env: Env) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';
  if (!slug) return { error: errorResponse('Missing slug', 400, req, env) };
  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return { error: errorResponse('Not found', 404, req, env) };
  }
  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
  return { stub, slug, poll };
}

export async function handleAdminExport(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const a = authedStub(req, env);
  if (a.error) return a.error;
  const data = await a.stub!.exportAll();
  // Attach the (non-secret) poll config so the export is self-contained.
  const body = {
    slug: a.slug,
    poll: {
      title: a.poll!.title,
      destination: a.poll!.destination,
      dateRangeStart: a.poll!.dateRangeStart,
      dateRangeEnd: a.poll!.dateRangeEnd,
      pollCloseAt: a.poll!.pollCloseAt,
      participants: a.poll!.participants.map((p) => ({ token: p.token, name: p.name })),
    },
    ...data,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="when-we-go-${a.slug}-export.json"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleAdminWipe(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const a = authedStub(req, env);
  if (a.error) return a.error;
  const url = new URL(req.url);
  if (url.searchParams.get('confirm') !== 'DELETE') {
    return jsonResponse(
      { ok: false, error: 'Add ?confirm=DELETE to confirm irreversible deletion.' },
      { status: 400 },
      req,
      env
    );
  }
  const removed = await a.stub!.wipeAll();
  return jsonResponse({ ok: true, wiped: true, removed }, { status: 200 }, req, env);
}
