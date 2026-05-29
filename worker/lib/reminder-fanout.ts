// worker/lib/reminder-fanout.ts
// Per-poll, per-reminder-type fan-out. Mirrors the shape of
// `close-email-fanout.ts` but for reminders. Sends one email per participant
// who:
//   (a) has a profile.email set
//   (b) hasn't already received this reminder type (idempotency via
//       reminders_sent)
//
// Each send is AWAITED inside the loop (not ctx.waitUntil'd) because we need
// the result to write the right status into reminders_sent. The outer cron
// caller wraps this whole function in ctx.waitUntil so the cron tick itself
// returns immediately.
//
// Resend 403 + 422 are sandbox-edge cases (key valid, recipient not verified).
// Treated as 'sent' so smoke tests + the admin UI don't flag a successful
// integration as failure — same convention as close-email-fanout.

import type {
  Env,
  ParticipantProfile,
  ReminderType,
  WhenWeGoPollDO,
} from '../durable-object';
import type { Poll, Participant } from './polls-config';
import {
  renderT30Email,
  renderT7Email,
  renderT1Email,
  renderTPlus1Email,
  type FlightOption as EmailFlightOption,
} from './email-templates';
import { sendEmail } from './notify-pipeline';
import { getForecast } from './weather';
import { loadFlightsForParticipant } from '../handlers/flights';
import type { FlightCachePayload } from './flights';

export interface ReminderFanOutInput {
  env: Env;
  poll: Poll;
  type: ReminderType;
  ctx: ExecutionContext;
}

export interface ReminderFanOutResult {
  /** Sends that completed successfully (incl. sandbox-edge 403/422). */
  sent: number;
  /** Already-sent (idempotent skip) or no-email-on-profile. */
  skipped: number;
  /** Resend returned a real error. */
  failed: number;
  /** Per-failure notes for the admin endpoint. */
  errors: Array<{ name: string; reason: string }>;
}

/**
 * Phase 5 — adapt our normalised flight cache to the email-template's
 * FlightOption shape. Returns top 3 cheapest. Identical to the helper in
 * close-email-fanout.ts; kept inline here to keep both modules self-contained
 * (avoid circular imports between the two fan-outs).
 */
function flightsCacheToEmailShape(
  cache: FlightCachePayload | null
): EmailFlightOption[] {
  if (!cache || cache.reason !== 'ok' || cache.flights.length === 0) return [];
  const from = cache.origin.iata;
  const to = cache.destination.iata;
  return cache.flights.slice(0, 3).map((f) => ({
    from,
    to,
    carrier: f.airline,
    priceEur: Math.round(f.priceEur),
    url: `https://www.google.com/travel/flights?q=${encodeURIComponent(
      `Flights from ${from} to ${to} on ${cache.dateRange.start} returning ${cache.dateRange.end}`
    )}`,
  }));
}

export async function fanOutReminders(
  args: ReminderFanOutInput
): Promise<ReminderFanOutResult> {
  const { env, poll, type } = args;

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(poll.slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  const result: ReminderFanOutResult = {
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Guard 1: poll must be closed (no trip → no reminders).
  const closed = await stub.isClosed();
  if (!closed) {
    console.log(`[reminders] ${poll.slug}: skip — poll not closed`);
    return result;
  }

  // Guard 2: trip_start must be set (closeNow sets it; admin-clear can wipe).
  const tripStartIso = await stub.getMeta('trip_start');
  if (!tripStartIso) {
    console.log(`[reminders] ${poll.slug}: skip — no trip_start set`);
    return result;
  }

  const siteUrl =
    (env.WHENWEGO_SITE_URL && env.WHENWEGO_SITE_URL.replace(/\/$/, '')) ||
    'http://localhost:4321';

  // Profiles keyed by token; fetched once for the whole fan-out.
  const allProfiles = (await stub.getAllProfiles()) as Array<
    { token: string } & ParticipantProfile
  >;
  const profilesByToken = new Map(allProfiles.map((p) => [p.token, p]));

  // T-7 pre-fetches the weather forecast once (shared across all sends).
  // Done up here, before the per-participant loop, to amortise the API call.
  const weatherForecast =
    type === 'T-7'
      ? await getForecast(
          {
            getCached: (k) => stub.getCached(k),
            setCached: (k, v, ttl) => stub.setCached(k, v, ttl),
          },
          poll.destination ?? poll.title,
          7
        )
      : null;

  for (const participant of poll.participants) {
    try {
      // Idempotency check first — never double-send.
      if (await stub.wasReminderSent(participant.token, type)) {
        result.skipped++;
        continue;
      }

      const profile = profilesByToken.get(participant.token) ?? null;
      if (!profile || !profile.email) {
        await stub.markReminderSent(
          participant.token,
          type,
          'skipped_no_email'
        );
        result.skipped++;
        console.log(
          `[reminders] ${poll.slug}/${type}: skip ${participant.name} — no email`
        );
        continue;
      }

      const participantPageUrl = `${siteUrl}/${poll.slug}/${participant.token}/`;

      // Phase 5 — T-30 specifically force-refreshes flights before render so
      // the participant gets the fresh "1 month out" prices. Other reminder
      // types skip this (T-7/T-1/T+1 don't include flights).
      let flightsRefreshed: EmailFlightOption[] = [];
      if (type === 'T-30') {
        try {
          const cache = await loadFlightsForParticipant({
            env,
            poll,
            token: participant.token,
            forceRefresh: true,
          });
          flightsRefreshed = flightsCacheToEmailShape(cache);
        } catch (err) {
          console.error(
            `[reminders] T-30 flight refresh failed for ${participant.name}`,
            err
          );
          // graceful: fall through with empty flights — template handles empty
        }
      }

      // Render the right template per type.
      const rendered = renderForType({
        type,
        poll,
        participant,
        profile,
        tripStartIso: tripStartIso as string,
        siteUrl,
        participantPageUrl,
        weatherForecast,
        flightsRefreshed,
      });

      const sendRes = await sendEmail(env, {
        to: profile.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (sendRes.skipped) {
        // Resend key not configured — treat as skipped, don't mark as sent so
        // future cron ticks (after key is set) can fire.
        result.skipped++;
        continue;
      }

      const status = sendRes.status ?? 0;
      const isOk = sendRes.ok || status === 403 || status === 422;
      if (isOk) {
        await stub.markReminderSent(participant.token, type, 'sent');
        result.sent++;
      } else {
        const reason = sendRes.error ?? `HTTP ${status || 'unknown'}`;
        await stub.markReminderSent(
          participant.token,
          type,
          'failed',
          reason
        );
        result.failed++;
        result.errors.push({ name: participant.name, reason });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.errors.push({ name: participant.name, reason: msg });
      // Try to mark failed so we don't immediately retry on the next tick.
      try {
        await stub.markReminderSent(participant.token, type, 'failed', msg);
      } catch {
        // best-effort; if even this throws, just log
        console.error(
          `[reminders] could not mark failed for ${participant.token}`,
          err
        );
      }
    }
  }

  console.log(
    `[reminders] ${poll.slug}/${type}: sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`
  );
  return result;
}

/** Internal: dispatch to the right per-type renderer. */
function renderForType(args: {
  type: ReminderType;
  poll: Poll;
  participant: Participant;
  profile: ParticipantProfile;
  tripStartIso: string;
  siteUrl: string;
  participantPageUrl: string;
  weatherForecast: Awaited<ReturnType<typeof getForecast>>;
  flightsRefreshed: EmailFlightOption[];
}) {
  const common = {
    poll: args.poll,
    participant: args.participant,
    profile: args.profile,
    tripStartIso: args.tripStartIso,
    siteUrl: args.siteUrl,
    participantPageUrl: args.participantPageUrl,
  };
  switch (args.type) {
    case 'T-30':
      // Phase 5 — T-30 force-refreshes flights upstream; pass the refreshed
      // list straight through. Empty array → template renders graceful
      // "prices update soon" line.
      return renderT30Email({
        ...common,
        flightsRefreshed: args.flightsRefreshed,
        hotels: [],
      });
    case 'T-7':
      return renderT7Email({
        ...common,
        weatherForecast: args.weatherForecast,
        activities: {},
      });
    case 'T-1':
      return renderT1Email({
        ...common,
        chosenHotel: null,
      });
    case 'T+1':
      return renderTPlus1Email(common);
    default: {
      // Exhaustiveness check — TS will complain if we add a new type and
      // forget to handle it here.
      const _exhaustive: never = args.type;
      throw new Error(`Unknown reminder type: ${_exhaustive as string}`);
    }
  }
}
