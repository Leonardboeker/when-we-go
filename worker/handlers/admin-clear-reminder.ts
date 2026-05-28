// worker/handlers/admin-clear-reminder.ts
// POST /api/admin/clear-reminder?slug=X&token=Y&type=T-7
// Removes a single reminders_sent row so the next cron tick (or an
// admin-send-reminder call) will re-fire the email. Used when:
//   - A participant changed their email after the reminder went out and
//     wants the updated content
//   - Admin is testing the pipeline and needs to reset
//
// Auth: organiser token. Wrong token → 404.
// Token in query string identifies the PARTICIPANT (not the org); the org
// token in the header authorises the action.
//
// Response: { ok: true, cleared: true }.
import type { Env, WhenWeGoPollDO, ReminderType } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';

const VALID_TYPES = new Set<ReminderType>(['T-30', 'T-7', 'T-1', 'T+1']);

export async function handleAdminClearReminder(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const typeRaw = url.searchParams.get('type') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
  }
  if (!token) {
    return errorResponse('Missing token', 400, req, env);
  }
  if (!VALID_TYPES.has(typeRaw as ReminderType)) {
    return errorResponse(
      `Invalid type "${typeRaw}" — must be one of T-30, T-7, T-1, T+1`,
      400,
      req,
      env
    );
  }
  const type = typeRaw as ReminderType;

  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  // Defensive: the token must belong to a real participant of this poll.
  // (We don't want to be a generic SQL-DELETE endpoint for arbitrary tokens.)
  const isParticipant = poll.participants.some((p) => p.token === token);
  if (!isParticipant) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  await stub.clearReminder(token, type);

  return jsonResponse(
    { ok: true, cleared: true, type, token },
    { status: 200 },
    req,
    env
  );
}
