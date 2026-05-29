// worker/handlers/admin-export-paymeback.ts
// Phase 10 — GET /api/admin/export-paymeback?slug=X
//
// Returns the pay-me-back-shaped JSON array, ready to paste into a
// pay-me-back deployment's `data/debtors.json`.
//
// Privacy boundary (CONTEXT D-08): tokens in the export are FRESH nanoid(16),
// NOT reused from when-we-go participant tokens. Reusing would leak
// "Sister's pay-me-back URL is the same as her when-we-go URL".
//
// Shape per entry (matches pay-me-back/data/debtors.example.json):
//   {
//     token: "<fresh-nanoid-16>",
//     name: "Sister",
//     amount: 224,
//     backstory: "Copenhagen, Denmark trip Jul 12-15 — your share of hotel (€105) + flight from Munich (€119)",
//     characterSlug: "placeholder",
//     createdAt: "2026-05-29T12:34:56.789Z"
//   }
//
// Each participant gets one row; amount = hotel + flight + other (using stored
// DO values when present, otherwise the computed defaults — same logic as
// admin-cost-split GET).
//
// Auth: X-Organizer-Token. Wrong/missing → 404.
import { nanoid } from 'nanoid';
import type {
  Env,
  WhenWeGoPollDO,
  CostSplitRow,
  ParticipantProfile,
} from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import {
  computeDefaultsForPoll,
  type ChosenHotelMeta,
} from '../lib/cost-defaults';

export interface PayMeBackDebtor {
  token: string;
  name: string;
  amount: number;
  backstory: string;
  characterSlug: string;
  createdAt: string;
}

export async function handleAdminExportPaymeback(
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

  // Pre-fetch everything in parallel.
  const flightKeys = poll.participants.map((p) => `flights:${p.token}`);
  const [chosenHotelRaw, allSplits, allProfiles, ...flightResults] =
    await Promise.all([
      stub.getMeta('chosen_hotel'),
      stub.getAllCostSplits(),
      stub.getAllProfiles(),
      ...flightKeys.map((k) => stub.getCached(k)),
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
  const profileByToken = new Map(
    (allProfiles as Array<{ token: string } & ParticipantProfile>).map((p) => [
      p.token,
      p,
    ])
  );

  let chosenHotel: ChosenHotelMeta | null = null;
  if (chosenHotelRaw) {
    try {
      chosenHotel = JSON.parse(chosenHotelRaw as string) as ChosenHotelMeta;
    } catch {
      chosenHotel = null;
    }
  }

  const dateLabel = formatDateRangeShort(poll.dateRangeStart, poll.dateRangeEnd);
  const destination = poll.destination ?? poll.title;
  const createdAt = new Date().toISOString();

  const debtors: PayMeBackDebtor[] = poll.participants.map((p) => {
    const stored = splitsByToken.get(p.token);
    const d = defaults.get(p.token) ?? {
      hotelShareEur: 0,
      flightEur: 0,
      otherEur: 0,
    };
    const hotelShareEur = stored ? stored.hotel_share_eur : d.hotelShareEur;
    const flightEur = stored ? stored.flight_eur : d.flightEur;
    const otherEur = stored ? stored.other_eur : d.otherEur;
    const amount = hotelShareEur + flightEur + otherEur;
    const profile = profileByToken.get(p.token);

    return {
      // CRITICAL: fresh nanoid — never reuse the when-we-go participant token.
      token: nanoid(16),
      name: p.name,
      amount,
      backstory: buildBackstory({
        destination,
        dateLabel,
        hotelShareEur,
        flightEur,
        otherEur,
        homeCity: profile?.homeCity,
        notes: stored?.notes ?? null,
      }),
      characterSlug: 'placeholder',
      createdAt,
    };
  });

  // Bonus context surfaced as response metadata — pay-me-back ignores it
  // (it consumes the array directly), but the UI uses it for the modal header.
  return jsonResponse(
    {
      ok: true,
      slug: poll.slug,
      destination,
      dateLabel,
      chosenHotel,
      debtors,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
    req,
    env
  );
}

interface BackstoryInput {
  destination: string;
  dateLabel: string;
  hotelShareEur: number;
  flightEur: number;
  otherEur: number;
  homeCity?: string;
  notes?: string | null;
}

function buildBackstory(i: BackstoryInput): string {
  const parts: string[] = [];
  if (i.hotelShareEur > 0) parts.push(`hotel (€${i.hotelShareEur})`);
  if (i.flightEur > 0) {
    parts.push(
      i.homeCity
        ? `flight from ${i.homeCity} (€${i.flightEur})`
        : `flight (€${i.flightEur})`
    );
  }
  if (i.otherEur > 0) parts.push(`other (€${i.otherEur})`);
  const breakdown =
    parts.length === 0
      ? 'your share (organiser will fill in details)'
      : `your share of ${parts.join(' + ')}`;
  const base = `${i.destination} trip ${i.dateLabel} — ${breakdown}`;
  return i.notes ? `${base}. ${i.notes}` : base;
}

// "2026-07-12" + "2026-07-15" → "Jul 12-15".
// Cross-month → "Jul 28 - Aug 2". Same date → "Jul 12".
function formatDateRangeShort(startIso: string, endIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso}-${endIso}`;
  }
  const sMonth = start.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  const eMonth = end.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  const sDay = start.getUTCDate();
  const eDay = end.getUTCDate();
  if (sMonth === eMonth) {
    return sDay === eDay ? `${sMonth} ${sDay}` : `${sMonth} ${sDay}-${eDay}`;
  }
  return `${sMonth} ${sDay} - ${eMonth} ${eDay}`;
}
