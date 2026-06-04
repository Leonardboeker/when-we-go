// worker/handlers/push.ts
// #9 — Web Push subscription endpoints. The whole pipeline is OFF unless both
// VAPID keys are set, so the app behaves identically to before when they're
// absent (the client checks /api/push/key, gets 503, and hides the prompt).
//   GET  /api/push/key                       → { publicKey } or 503
//   POST /api/push/subscribe {slug,token,subscription} → store, or 503
import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateParticipantToken } from '../lib/polls-config';

function pushConfigured(env: Env): boolean {
  return Boolean(env.WHENWEGO_VAPID_PUBLIC_KEY && env.WHENWEGO_VAPID_PRIVATE_KEY);
}

export async function handlePushKey(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  if (!pushConfigured(env)) {
    return jsonResponse(
      { ok: false, reason: 'not_configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
      req,
      env
    );
  }
  return jsonResponse(
    { ok: true, publicKey: env.WHENWEGO_VAPID_PUBLIC_KEY },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}

export async function handlePushSubscribe(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  if (!pushConfigured(env)) {
    return jsonResponse({ ok: false, reason: 'not_configured' }, { status: 503 }, req, env);
  }
  let body: { slug?: string; token?: string; subscription?: { endpoint?: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON', 400, req, env);
  }
  const slug = (body.slug ?? '').trim();
  const token = (body.token ?? '').trim();
  const sub = body.subscription;
  if (!slug || !token) return errorResponse('Missing slug or token', 400, req, env);
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint) {
    return errorResponse('Invalid subscription', 400, req, env);
  }

  const poll = findPoll(env, slug);
  if (!poll) return errorResponse('Not found', 404, req, env);
  if (!validateParticipantToken(poll, token)) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
  await stub.addPushSubscription(token, sub.endpoint, JSON.stringify(sub));

  return jsonResponse(
    { ok: true, subscribed: true },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
