// worker/handlers/admin-reminders.ts
// GET /api/admin/reminder-status?slug=X
// Org-token-gated. Returns the full reminders_sent table plus trip_start so
// the organiser dashboard can render a "who got what" matrix.
//
// Response shape:
//   {
//     ok: true,
//     tripStart: "2026-07-12" | null,
//     status: [
//       { token, type, sent_at, status, error },
//       ...
//     ]
//   }
//
// Wrong / missing org token → 404 (mirror admin-poll).
import type {
  Env,
  WhenWeGoPollDO,
  ReminderStatusRow,
} from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';

export async function handleAdminReminderStatus(
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
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const [status, tripStart] = await Promise.all([
    stub.getReminderStatus(),
    stub.getMeta('trip_start'),
  ]);

  return jsonResponse(
    {
      ok: true,
      tripStart: (tripStart as string | null) || null,
      status: status as ReminderStatusRow[],
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
