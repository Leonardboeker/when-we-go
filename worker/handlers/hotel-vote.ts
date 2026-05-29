// worker/handlers/hotel-vote.ts
// Phase 6 — POST /api/hotel-vote { slug, token, hotelId }
//
// Participant preference vote. Increments `poll_meta.hotel_votes` (JSON map
// of { hotelId: count }) and returns the updated tallies.
//
// Idempotency: per-(token, hotelId) — a participant can re-cast their vote to
// move it to a different hotel; their previous selection (if any) is
// decremented. Stored in `poll_meta.hotel_vote_by:<token>`.
//
// Wrong token / unknown slug → 404. Missing hotelId → 400.

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateParticipantToken } from '../lib/polls-config';

interface HotelVoteBody {
  slug?: string;
  token?: string;
  hotelId?: string;
}

async function readTallies(
  stub: DurableObjectStub<WhenWeGoPollDO>
): Promise<Record<string, number>> {
  const raw = await stub.getMeta('hotel_votes');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw as string) as Record<string, number>;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* fall through */
  }
  return {};
}

export async function handleHotelVote(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, req, env);
  }

  let body: HotelVoteBody = {};
  try {
    body = (await req.json()) as HotelVoteBody;
  } catch {
    return errorResponse('Invalid JSON body', 400, req, env);
  }

  const slug = (body.slug ?? '').trim();
  const token = (body.token ?? '').trim();
  const hotelId = (body.hotelId ?? '').trim();

  if (!slug || !token) {
    return errorResponse('Missing slug or token', 400, req, env);
  }
  if (!hotelId) {
    return errorResponse('Missing hotelId', 400, req, env);
  }

  const poll = findPoll(env, slug);
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }
  const participant = validateParticipantToken(poll, token);
  if (!participant) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const tallies = await readTallies(stub);

  // Previous vote (if any) → decrement.
  const prevKey = `hotel_vote_by:${token}`;
  const prev = await stub.getMeta(prevKey);
  if (prev && typeof prev === 'string' && prev !== hotelId) {
    const cur = tallies[prev] ?? 0;
    tallies[prev] = Math.max(0, cur - 1);
    if (tallies[prev] === 0) delete tallies[prev];
  }

  // Skip if already voted for this hotel — preserves idempotency.
  if (prev !== hotelId) {
    tallies[hotelId] = (tallies[hotelId] ?? 0) + 1;
    await stub.setMeta(prevKey, hotelId);
    await stub.setMeta('hotel_votes', JSON.stringify(tallies));
  }

  return jsonResponse(
    {
      ok: true,
      hotelId,
      voteTallies: tallies,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
