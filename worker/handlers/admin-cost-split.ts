// worker/handlers/admin-cost-split.ts
// Phase 10 — GET + POST /api/admin/cost-split?slug=X
//
// GET  → returns the suggested + stored cost split for every participant.
//        Shape:
//          {
//            ok: true,
//            chosenHotel: { name?, totalPriceEur? } | null,
//            defaultsApplied: boolean,    // false if any DO row exists
//            participants: [
//              {
//                token, name,
//                hotelShareEur, flightEur, otherEur, totalEur,
//                notes
//              }, ...
//            ]
//          }
//        For each participant the row uses the stored DO value if present,
//        otherwise the computed default (which may be all-zero pre-Phase 5/6).
//
// POST → bulk update. Body: { splits: [{ token, hotelShareEur, flightEur,
//        otherEur, notes? }, ...] }. Only tokens that belong to the poll are
//        persisted (everything else silently dropped to prevent cross-poll writes).
//
// Auth: X-Organizer-Token. Wrong/missing → 404 (mirrors admin-poll).
import type { Env, WhenWeGoPollDO, CostSplitRow } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import {
  computeDefaultsForPoll,
  type ChosenHotelMeta,
} from '../lib/cost-defaults';

interface PostSplitInput {
  token: string;
  hotelShareEur: number;
  flightEur: number;
  otherEur: number;
  notes?: string;
}

export async function handleAdminCostSplit(
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

  if (req.method === 'POST') {
    return handlePost(req, env, poll, stub);
  }
  return handleGet(req, env, poll, stub);
}

async function handleGet(
  req: Request,
  env: Env,
  poll: ReturnType<typeof findPoll> & object,
  stub: DurableObjectStub<WhenWeGoPollDO>
): Promise<Response> {
  // Fetch chosen hotel + all per-participant flight caches in parallel with
  // the existing cost_split rows.
  const flightKeys = poll.participants.map((p) => `flights:${p.token}`);
  const flightFetches = flightKeys.map((k) => stub.getCached(k));
  const [chosenHotelRaw, allSplits, ...flightResults] = await Promise.all([
    stub.getMeta('chosen_hotel'),
    stub.getAllCostSplits(),
    ...flightFetches,
  ]);

  const flightCacheByToken = new Map<string, string | null>();
  poll.participants.forEach((p, i) => {
    flightCacheByToken.set(p.token, (flightResults[i] as string | null) ?? null);
  });

  const defaults = computeDefaultsForPoll(
    poll,
    chosenHotelRaw as string | null,
    flightCacheByToken
  );

  const splitsByToken = new Map(
    (allSplits as CostSplitRow[]).map((s) => [s.token, s])
  );
  const defaultsApplied = (allSplits as CostSplitRow[]).length === 0;

  const participants = poll.participants.map((p) => {
    const stored = splitsByToken.get(p.token);
    const d = defaults.get(p.token) ?? {
      hotelShareEur: 0,
      flightEur: 0,
      otherEur: 0,
    };
    const hotelShareEur = stored ? stored.hotel_share_eur : d.hotelShareEur;
    const flightEur = stored ? stored.flight_eur : d.flightEur;
    const otherEur = stored ? stored.other_eur : d.otherEur;
    return {
      token: p.token,
      name: p.name,
      hotelShareEur,
      flightEur,
      otherEur,
      totalEur: hotelShareEur + flightEur + otherEur,
      notes: stored?.notes ?? null,
    };
  });

  let chosenHotel: ChosenHotelMeta | null = null;
  if (chosenHotelRaw) {
    try {
      chosenHotel = JSON.parse(chosenHotelRaw as string) as ChosenHotelMeta;
    } catch {
      chosenHotel = null;
    }
  }

  return jsonResponse(
    {
      ok: true,
      chosenHotel,
      defaultsApplied,
      participants,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}

async function handlePost(
  req: Request,
  env: Env,
  poll: ReturnType<typeof findPoll> & object,
  stub: DurableObjectStub<WhenWeGoPollDO>
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Malformed JSON body', 400, req, env);
  }

  const splits = (body as { splits?: unknown })?.splits;
  if (!Array.isArray(splits)) {
    return errorResponse('Body must be { splits: [...] }', 400, req, env);
  }

  const validTokens = new Set(poll.participants.map((p) => p.token));
  const inputs: PostSplitInput[] = [];
  for (const s of splits as unknown[]) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    if (typeof r.token !== 'string' || !validTokens.has(r.token)) continue;
    const h = Number(r.hotelShareEur ?? 0);
    const f = Number(r.flightEur ?? 0);
    const o = Number(r.otherEur ?? 0);
    if (!Number.isFinite(h) || h < 0) {
      return errorResponse(`Invalid hotelShareEur for ${r.token}`, 400, req, env);
    }
    if (!Number.isFinite(f) || f < 0) {
      return errorResponse(`Invalid flightEur for ${r.token}`, 400, req, env);
    }
    if (!Number.isFinite(o) || o < 0) {
      return errorResponse(`Invalid otherEur for ${r.token}`, 400, req, env);
    }
    inputs.push({
      token: r.token,
      hotelShareEur: h,
      flightEur: f,
      otherEur: o,
      notes:
        typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : undefined,
    });
  }

  // Persist in parallel. DO serialises method calls anyway, so this is just
  // a syntactic batch; SQL row-by-row.
  await Promise.all(
    inputs.map((i) =>
      stub.setCostSplit(i.token, {
        hotelShareEur: i.hotelShareEur,
        flightEur: i.flightEur,
        otherEur: i.otherEur,
        notes: i.notes,
      })
    )
  );

  return jsonResponse(
    { ok: true, updated: inputs.length },
    { status: 200 },
    req,
    env
  );
}
