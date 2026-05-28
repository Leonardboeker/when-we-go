// worker/handlers/admin-send-reminder.ts
// POST /api/admin/send-reminder?slug=X&type=T-7
// Force-fires the fan-out for a specific reminder type, regardless of cron
// window. Useful for:
//   - Testing the email pipeline before any reminder is due
//   - Re-sending after clearing a participant's row via admin-clear-reminder
//
// Auth: organiser token via header. Wrong token → 404.
//
// Response: { ok, sent, skipped, failed, errors } from the fan-out.
import type { Env, ReminderType } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { fanOutReminders } from '../lib/reminder-fanout';

const VALID_TYPES = new Set<ReminderType>(['T-30', 'T-7', 'T-1', 'T+1']);

export async function handleAdminSendReminder(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const typeRaw = url.searchParams.get('type') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
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

  // Synchronous: wait for the fan-out so the response carries exact counts.
  // Admin-initiated → small wait acceptable (cron uses ctx.waitUntil).
  const result = await fanOutReminders({ env, poll, type, ctx });

  return jsonResponse(
    {
      ok: true,
      type,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      errors: result.errors,
    },
    { status: 200 },
    req,
    env
  );
}
