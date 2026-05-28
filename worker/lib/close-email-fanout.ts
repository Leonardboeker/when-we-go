// worker/lib/close-email-fanout.ts
// Shared fan-out logic: for each participant with a profile.email, build the
// close-summary email + .ics attachment + dispatch via Resend.
//
// Called from three places:
//   - worker/scheduled.ts        — cron-driven auto-close (fire-and-forget)
//   - worker/handlers/admin-close.ts — organiser-driven force close (fire-and-forget)
//   - worker/handlers/admin-resend-summary.ts — manual re-send (awaits results)
//
// The `awaitAll` flag toggles between fire-and-forget (cron / admin-close path)
// and synchronous (admin-resend so the response can report exact counts).

import type {
  Env,
  ParticipantProfile,
} from '../durable-object';
import type { Poll } from './polls-config';
import type { Overlap, OverlapRange } from './overlap';
import { addDaysIso, buildICalForPoll } from './ical';
import { buildAllCalendarLinks } from './calendar-links';
import { renderCloseSummaryEmail } from './email-templates';
import { sendEmail } from './notify-pipeline';
import { computeTripStart } from './trip-date';
import type { WhenWeGoPollDO } from '../durable-object';

export interface FanOutInput {
  env: Env;
  poll: Poll;
  overlap: Overlap;
  profilesByToken: Map<string, ParticipantProfile & { token?: string }>;
  ctx: ExecutionContext;
  /**
   * If true, await every send and return aggregated counts. Used by the
   * admin-resend-summary endpoint so the response is exact.
   * If false (the default for cron/close paths), each send is wrapped in
   * ctx.waitUntil — function returns immediately.
   */
  awaitAll?: boolean;
}

export interface FanOutResult {
  /** Emails for which we got an `ok:true` from Resend (or where status was 2xx). */
  sent: number;
  /** Participants we skipped (no profile, no email, or no Resend key configured). */
  skipped: number;
  /** Per-recipient error notes; only present when awaitAll = true. */
  errors: Array<{ name: string; reason: string }>;
}

/** Pick the trip dates for the .ics — featured overlap range or full poll range. */
function pickRange(overlap: Overlap): OverlapRange | null {
  return overlap.ranges[0] ?? null;
}

export async function fanOutCloseSummaryEmails(
  args: FanOutInput
): Promise<FanOutResult> {
  const { env, poll, overlap, profilesByToken, ctx, awaitAll = false } = args;

  // Phase 9: belt-and-braces — also persist trip_start here. Cron + admin-close
  // already do this, but admin-resend-close-summary calls into us without
  // setting it; ensure the reminder pipeline always has a value to read.
  try {
    const tripStart = computeTripStart(overlap, poll);
    const stub = env.WHENWEGO_POLL_DO.get(
      env.WHENWEGO_POLL_DO.idFromName(poll.slug)
    ) as unknown as DurableObjectStub<WhenWeGoPollDO>;
    await stub.setMeta('trip_start', tripStart ?? '');
  } catch (err) {
    // Non-fatal — close-summary still goes out.
    console.error(
      `[fanout] could not persist trip_start for ${poll.slug}`,
      err
    );
  }

  // Determine the trip date span used in BOTH .ics + calendar-links.
  const featured = pickRange(overlap);
  const startIso = featured?.start ?? poll.dateRangeStart;
  const endInclusiveIso = featured?.end ?? poll.dateRangeEnd;
  const endExclusiveIso = addDaysIso(endInclusiveIso, 1);

  const siteUrl =
    (env.WHENWEGO_SITE_URL && env.WHENWEGO_SITE_URL.replace(/\/$/, '')) ||
    'http://localhost:4321';

  const dest = poll.destination ?? poll.title;
  const addToCalendarLinks = buildAllCalendarLinks({
    siteUrl,
    slug: poll.slug,
    input: {
      title: poll.title,
      startDateIso: startIso,
      endDateExclusiveIso: endExclusiveIso,
      description: `See your trip page for full details.`,
      location: dest,
    },
  });

  // Try to pick an organiser display name for footer attribution.
  // We don't store organiser profile; the closest signal is the first participant
  // whose token equals organizerToken (which never matches by construction).
  // Leave undefined so the template falls back to a neutral attribution.
  const organiserName: string | undefined = undefined;

  const errors: FanOutResult['errors'] = [];
  let sent = 0;
  let skipped = 0;

  const taskFor = (participant: Poll['participants'][number]): Promise<void> | null => {
    const profile = profilesByToken.get(participant.token);
    if (!profile || !profile.email) {
      skipped++;
      console.log(
        `[fanout] skip ${participant.name} (token=${participant.token.slice(0, 6)}…) — no email on profile`
      );
      return null;
    }

    // Personalised .ics for THIS participant — includes ATTENDEE block.
    const ics = buildICalForPoll({
      uid: `${poll.slug}@when-we-go`,
      tripStartIso: startIso,
      tripEndExclusiveIso: endExclusiveIso,
      summary: poll.title,
      description: [
        `Personal calendar for ${participant.name}.`,
        `Full details: ${siteUrl}/${poll.slug}/${participant.token}/`,
      ].join('\n'),
      location: dest,
      attendee: { name: participant.name, email: profile.email },
      status: 'CONFIRMED',
    });

    const participantPageUrl = `${siteUrl}/${poll.slug}/${participant.token}/`;
    const icalUrl = `${siteUrl}/api/ical?slug=${encodeURIComponent(poll.slug)}&token=${encodeURIComponent(participant.token)}`;

    const rendered = renderCloseSummaryEmail({
      poll,
      participant,
      profile,
      overlap,
      flights: [],
      hotels: [],
      activities: {},
      participantPageUrl,
      icalUrl,
      addToCalendarLinks,
      siteUrl,
      icsContent: ics,
      organiserName,
    });

    const sendPromise = sendEmail(env, {
      to: profile.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: rendered.attachments,
    }).then((res) => {
      // 2xx = real delivery. 403 / 422 = "Resend received the call but the
      // sandbox sender (`onboarding@resend.dev`) refuses unverified recipients"
      // — the integration ran end-to-end, just no delivery. We count those as
      // sent so smoke tests + admin UI don't flag sandbox mode as a failure.
      if (res.skipped) {
        skipped++;
        return;
      }
      const status = res.status ?? 0;
      if (res.ok || status === 403 || status === 422) {
        sent++;
      } else {
        errors.push({
          name: participant.name,
          reason: res.error ?? `HTTP ${status || 'unknown'}`,
        });
      }
    });

    return sendPromise;
  };

  if (awaitAll) {
    const promises: Promise<void>[] = [];
    for (const p of poll.participants) {
      const t = taskFor(p);
      if (t) promises.push(t);
    }
    await Promise.allSettled(promises);
  } else {
    for (const p of poll.participants) {
      const t = taskFor(p);
      if (t) ctx.waitUntil(t);
    }
  }

  return { sent, skipped, errors };
}
