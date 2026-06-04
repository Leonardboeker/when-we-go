// worker/handlers/comment.ts
// #6 — POST /api/comment { slug, token, date, text }
// Add a short note to a specific date ("kann nur abends"). Any valid
// participant token. The name is taken from the poll config (not the body) so
// it can't be spoofed. Text is trimmed + capped at 200 chars; max 5 comments
// per (token, date) to prevent spam. Comments come back via GET /api/poll.
import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateParticipantToken } from '../lib/polls-config';

const MAX_LEN = 200;
const MAX_PER_DATE = 5;

export async function handleComment(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  let body: { slug?: string; token?: string; date?: string; text?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON', 400, req, env);
  }

  const slug = (body.slug ?? '').trim();
  const token = (body.token ?? '').trim();
  const date = (body.date ?? '').trim();
  const text = (body.text ?? '').trim().slice(0, MAX_LEN);

  if (!slug || !token) return errorResponse('Missing slug or token', 400, req, env);
  if (!text) return errorResponse('Empty comment', 400, req, env);

  const poll = findPoll(env, slug);
  if (!poll) return errorResponse('Not found', 404, req, env);
  const participant = validateParticipantToken(poll, token);
  if (!participant) return errorResponse('Not found', 404, req, env);

  // Date must be a YYYY-MM-DD within the poll window.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < poll.dateRangeStart || date > poll.dateRangeEnd) {
    return errorResponse('Date outside poll window', 400, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const existing = await stub.countCommentsFor(token, date);
  if (existing >= MAX_PER_DATE) {
    return jsonResponse(
      { ok: false, error: 'Zu viele Notizen für diesen Tag.' },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
      req,
      env
    );
  }

  const { id } = await stub.addComment(token, participant.name, date, text);

  return jsonResponse(
    { ok: true, id, comment: { name: participant.name, date, text, isMine: true } },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
