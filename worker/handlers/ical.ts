// worker/handlers/ical.ts
// Two iCal endpoints:
//
//   GET /api/ical?slug=X&token=Y    → personalised .ics
//                                     - Y = participant token: full event +
//                                       ATTENDEE block with participant name/email
//                                     - Y = organiser token: same as participant
//                                       (no special admin variant for now)
//                                     - Y missing: public minimal .ics (no ATTENDEE)
//
//   GET /ical/<slug>.ics            → public minimal .ics (shareable; no token)
//                                     Same body as the no-token GET /api/ical case.
//
// Both return `Content-Type: text/calendar; charset=utf-8` with a 5-minute
// cache (content rarely changes after close).

import type { Env, WhenWeGoPollDO, ParticipantProfile } from '../durable-object';
import { errorResponse } from '../lib/cors';
import {
  findPoll,
  validateParticipantToken,
  validateOrganizerToken,
} from '../lib/polls-config';
import { addDaysIso, buildICalForPoll } from '../lib/ical';
import type { Overlap, OverlapRange } from '../lib/overlap';
import { computeOverlap, type VoteRow } from '../lib/overlap';
import type { VoteRecord } from '../durable-object';

/** Pick the best range for the calendar event (mirrors email-templates logic). */
function pickFeaturedRange(overlap: Overlap | null): OverlapRange | null {
  if (!overlap) return null;
  return overlap.ranges[0] ?? null;
}

/** Resolve the trip dates to put in the .ics. */
function resolveTripDates(
  poll: { dateRangeStart: string; dateRangeEnd: string },
  overlap: Overlap | null
): { startIso: string; endInclusiveIso: string } {
  const featured = pickFeaturedRange(overlap);
  if (featured) {
    return { startIso: featured.start, endInclusiveIso: featured.end };
  }
  // Fallback: use the whole poll range (so the .ics is at least syntactically
  // valid even before close / when no overlap exists).
  return {
    startIso: poll.dateRangeStart,
    endInclusiveIso: poll.dateRangeEnd,
  };
}

function icalResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Shared internals: pull cached or fresh overlap, build .ics. Used by both
 * the authenticated `/api/ical` and the public `/ical/<slug>.ics` routes.
 */
async function buildIcsForSlug(args: {
  env: Env;
  slug: string;
  attendee?: { name: string; email: string };
}): Promise<string | null> {
  const poll = findPoll(args.env, args.slug);
  if (!poll) return null;

  const stub = args.env.WHENWEGO_POLL_DO.get(
    args.env.WHENWEGO_POLL_DO.idFromName(args.slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const [overlapCacheRaw, allVotes] = await Promise.all([
    stub.getMeta('overlap_cache'),
    stub.getAllVotes(),
  ]);

  let overlap: Overlap | null = null;
  if (overlapCacheRaw) {
    try {
      overlap = JSON.parse(overlapCacheRaw as string) as Overlap;
    } catch {
      overlap = null;
    }
  }
  if (!overlap) {
    // Live compute — gives the .ics a sensible date even pre-close.
    overlap = computeOverlap(
      poll,
      (allVotes as VoteRecord[]).map((v) => ({
        token: v.token,
        date: v.date,
        state: v.state,
      })) as VoteRow[]
    );
  }

  const { startIso, endInclusiveIso } = resolveTripDates(poll, overlap);
  // DTEND is EXCLUSIVE for all-day events per RFC 5545.
  const endExclusiveIso = addDaysIso(endInclusiveIso, 1);

  const dest = poll.destination ?? poll.title;
  const descriptionLines = [
    `Full details: see your trip page on when-we-go.`,
    `Slug: ${poll.slug}`,
  ];
  if (args.attendee) {
    descriptionLines.unshift(`Personal calendar for ${args.attendee.name}.`);
  }

  return buildICalForPoll({
    uid: `${poll.slug}@when-we-go`,
    tripStartIso: startIso,
    tripEndExclusiveIso: endExclusiveIso,
    summary: poll.title,
    description: descriptionLines.join('\n'),
    location: dest,
    attendee: args.attendee,
    status: 'CONFIRMED',
  });
}

/**
 * Authenticated/personalised: GET /api/ical?slug=X&token=Y.
 * Token may be participant or organiser; both get the ATTENDEE block populated
 * with that user's profile-stored email (if any).
 */
export async function handleIcal(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (!slug) {
    return errorResponse('Missing slug', 400, req, env);
  }

  const poll = findPoll(env, slug);
  if (!poll) {
    return errorResponse('Poll not found', 404, req, env);
  }

  let attendee: { name: string; email: string } | undefined;

  if (token) {
    // Try participant first, then organiser.
    const participant = validateParticipantToken(poll, token);
    if (participant) {
      // Need the email — look up profile.
      const stub = env.WHENWEGO_POLL_DO.get(
        env.WHENWEGO_POLL_DO.idFromName(slug)
      ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
      const profile = (await stub.getProfile(token)) as ParticipantProfile | null;
      if (profile?.email) {
        attendee = { name: participant.name, email: profile.email };
      }
    } else if (validateOrganizerToken(poll, token)) {
      // Organiser variant — minimal ATTENDEE if we can find a token (we don't
      // store organiser email; leave attendee unset to avoid bogus mailto).
      // Effectively same as the public .ics for organisers, which is fine.
    } else {
      // Wrong/unknown token — 404 (mirror Phase 2 admin behaviour: don't leak
      // poll existence on token failure).
      return errorResponse('Not found', 404, req, env);
    }
  }

  const ics = await buildIcsForSlug({ env, slug, attendee });
  if (!ics) {
    return errorResponse('Poll not found', 404, req, env);
  }
  return icalResponse(ics, `${slug}.ics`);
}

/**
 * Public/minimal: GET /ical/<slug>.ics. No token, no ATTENDEE block.
 * Used in email "Add to calendar (Apple)" links + shareable URLs.
 */
export async function handlePublicIcal(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  // URL like /ical/copenhagen-2026.ics — pull the slug between /ical/ and .ics.
  const m = url.pathname.match(/^\/ical\/([^/]+)\.ics$/);
  const slug = m?.[1] ?? '';
  if (!slug) {
    return errorResponse('Bad path', 400, req, env);
  }

  const ics = await buildIcsForSlug({ env, slug });
  if (!ics) {
    return errorResponse('Poll not found', 404, req, env);
  }
  return icalResponse(ics, `${slug}.ics`);
}
