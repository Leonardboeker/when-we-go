// worker/handlers/admin-hotel-choose.ts
// Phase 6 — POST /api/admin/hotel-choose { slug, hotelId }
//
// Organiser locks the shortlist to a single hotel. Writes two poll_meta keys:
//
//   chosen_hotel              JSON { hotelId, name, totalPriceEur, nightlyPriceEur, stars }
//                             — read by Phase 10 cost-defaults to auto-default
//                               the hotelShareEur (= ceil(totalPriceEur / guests)).
//   chosen_hotel_total_eur    integer EUR — same value, exposed as a flat number
//                             so cost-defaults doesn't have to re-JSON-parse the
//                             chosen-hotel blob.
//
// Resolves the hotel object from the current cache so we capture price/name at
// the moment the organiser made the call (real providers' prices drift; we
// don't want the cost-split to silently change later).
//
// Auth: X-Organizer-Token header. Wrong/missing → 404.

import type { Env, WhenWeGoPollDO } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { loadHotelsForPoll } from './hotels';

interface ChooseBody {
  slug?: string;
  hotelId?: string;
}

export async function handleAdminHotelChoose(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, req, env);
  }
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  let body: ChooseBody = {};
  try {
    body = (await req.json()) as ChooseBody;
  } catch {
    return errorResponse('Invalid JSON body', 400, req, env);
  }

  const slug = (body.slug ?? '').trim();
  const hotelId = (body.hotelId ?? '').trim();
  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
  }
  if (!hotelId) {
    return errorResponse('Missing hotelId', 400, req, env);
  }

  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  // Load the current cached shortlist (no force refresh — organisers should
  // choose from the list they're seeing).
  const payload = await loadHotelsForPoll({ env, poll });
  const hotel = payload.hotels.find((h) => h.hotelId === hotelId);
  if (!hotel) {
    return errorResponse(
      `Hotel ${hotelId} not in current shortlist`,
      400,
      req,
      env
    );
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  // Persist JSON shape consumed by:
  //   - GET /api/hotels       → exposes chosenHotelId
  //   - cost-defaults.ts      → totalPriceEur → hotelShareEur split
  //   - email-templates T-1   → "Where you're staying" block
  const chosenBlob = {
    hotelId: hotel.hotelId,
    name: hotel.name,
    stars: hotel.stars,
    totalPriceEur: hotel.totalPriceEur,
    nightlyPriceEur: hotel.nightlyPriceEur,
    perPersonEur: hotel.perPersonEur,
  };

  await Promise.all([
    stub.setMeta('chosen_hotel', JSON.stringify(chosenBlob)),
    // Flat field for cost-defaults to read without re-parsing the JSON blob.
    stub.setMeta('chosen_hotel_total_eur', String(hotel.totalPriceEur)),
  ]);

  return jsonResponse(
    {
      ok: true,
      chosenHotelId: hotel.hotelId,
      chosenHotel: chosenBlob,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}
