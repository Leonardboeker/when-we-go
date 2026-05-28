// worker/handlers/profile.ts
// POST /api/profile — set/update a participant's profile (email, home airport,
// budget, interests).
// Body: { slug, token, profile: { email?, homeAirport?, homeCity?, budgetMaxEur?, interests? } }
// Returns 200 { ok: true, profileComplete: bool } on success, error JSON otherwise.
//
// Profile updates are allowed even after the poll is closed — Phases 8+ still
// need profiles for close-summary emails, reminders, etc.
import type { Env, WhenWeGoPollDO, ParticipantProfile } from '../durable-object';
import { isProfileComplete } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { ProfileRequestSchema } from '../lib/schemas';
import { findPoll, validateParticipantToken } from '../lib/polls-config';

export async function handleProfile(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req, env);
  }
  const parsed = ProfileRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('Invalid request', 400, req, env);
  }
  const { slug, token, profile } = parsed.data;

  const poll = findPoll(env, slug);
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }
  const participant = validateParticipantToken(poll, token);
  if (!participant) {
    return errorResponse('Invalid token', 401, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // Coerce Zod-narrowed object into the DO's ParticipantProfile shape.
  // Schemas are intentionally identical but TS doesn't know that across the
  // worker/src boundary.
  const profilePayload: ParticipantProfile = {
    email: profile.email,
    homeAirport: profile.homeAirport,
    homeCity: profile.homeCity,
    budgetMaxEur: profile.budgetMaxEur,
    interests: profile.interests,
  };

  await stub.setProfile(token, profilePayload);

  return jsonResponse(
    {
      ok: true,
      profileComplete: isProfileComplete(profilePayload),
    },
    { status: 200 },
    req,
    env
  );
}
