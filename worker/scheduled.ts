// worker/scheduled.ts
// Hourly cron — for each poll, auto-close if pollCloseAt has passed and the DO
// isn't already marked closed. Cron expression "0 * * * *" set in wrangler.toml.
//
// Logic per CONTEXT A-06:
//   1. Walk polls in WHENWEGO_POLLS_JSON
//   2. Skip if poll_meta.closed_at already set
//   3. Skip if now < pollCloseAt
//   4. Open poll's DO → compute overlap → closeNow() → notify (idempotent)
import type {
  Env,
  WhenWeGoPollDO,
  VoteRecord,
  ParticipantProfile,
  ReminderType,
} from './durable-object';
import { loadPolls, type Poll } from './lib/polls-config';
import { computeOverlap, type VoteRow, type Overlap } from './lib/overlap';
import { notifyPollClose, sendEmail } from './lib/notify-pipeline';
import { fanOutCloseSummaryEmails } from './lib/close-email-fanout';
import { computeTripStart } from './lib/trip-date';
import { isInReminderWindow } from './lib/reminder-window';
import { fanOutReminders } from './lib/reminder-fanout';
import { loadFlightsForParticipant } from './handlers/flights';
import { loadHotelsForPoll } from './handlers/hotels';
import { loadActivitiesForPoll } from './handlers/activities';

const ALL_REMINDER_TYPES: ReminderType[] = ['T-30', 'T-7', 'T-1', 'T+1'];

export async function handleScheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  let polls;
  try {
    polls = loadPolls(env);
  } catch (err) {
    console.error('[cron] cannot load WHENWEGO_POLLS_JSON', err);
    return;
  }

  const now = Date.now();

  for (const poll of polls) {
    try {
      const closeAtMs = Date.parse(poll.pollCloseAt);
      if (!Number.isFinite(closeAtMs)) {
        console.error(`[cron] poll ${poll.slug} has invalid pollCloseAt`);
        continue;
      }

      const stub = env.WHENWEGO_POLL_DO.get(
        env.WHENWEGO_POLL_DO.idFromName(poll.slug)
      ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

      const alreadyClosed = await stub.isClosed();
      if (alreadyClosed) continue;

      // #8: a reopen override (future close) wins over the configured pollCloseAt.
      const override = await stub.getCloseOverride();
      const effectiveCloseMs = override ?? closeAtMs;
      if (now < effectiveCloseMs) continue; // not yet due

      const allVotes = (await stub.getAllVotes()) as VoteRecord[];
      const overlap = computeOverlap(
        poll,
        allVotes.map((v) => ({ token: v.token, date: v.date, state: v.state })) as VoteRow[]
      );
      const { closedAt } = await stub.closeNow(JSON.stringify(overlap));
      console.log(`[cron] closed ${poll.slug} at ${new Date(closedAt).toISOString()}`);

      // Phase 9: persist trip_start in poll_meta so the reminder cron loop
      // doesn't have to recompute every tick. Empty string means "no viable
      // trip" — reminder loop sees that and skips. Pass `poll` as fallback
      // so polls with no overlap consensus still get the planned start date
      // (organiser can clear-reminder + re-close if dates shift).
      const tripStart = computeTripStart(overlap, poll);
      await stub.setMeta('trip_start', tripStart ?? '');

      // Idempotency: only notify if not already notified.
      const notifiedAt = await stub.getMeta('close_notified_at');
      if (!notifiedAt) {
        await stub.setMeta('close_notified_at', String(closedAt));
        ctx.waitUntil(
          notifyPollClose(env, { pollSlug: poll.slug, overlap }).catch((err) => {
            console.error(`[cron] pollClose notify failed for ${poll.slug}`, err);
          })
        );

        // Phase 5: fan-out flight fetches for every participant with a
        // homeAirport. Promise.allSettled so a single slow/failed call
        // doesn't block the others (and the entire close flow doesn't
        // hang on Amadeus). Wrapped in try/catch so even total failure
        // here doesn't break the close-summary email fan-out below.
        try {
          await fetchFlightsForCloseFanout(env, poll);
        } catch (err) {
          console.error(`[cron] flights pre-fetch failed for ${poll.slug}`, err);
        }

        // Phase 6: pre-fetch the shared hotel shortlist into the cache so
        // the close-summary email + post-close UI both hit warm data. One
        // call per poll (shared list — not per-participant).
        try {
          const hotels = await loadHotelsForPoll({ env, poll });
          console.log(
            `[cron] hotels pre-fetch for ${poll.slug}: reason=${hotels.reason} count=${hotels.hotels.length}`
          );
        } catch (err) {
          console.error(`[cron] hotels pre-fetch failed for ${poll.slug}`, err);
        }

        // Phase 7: pre-fetch the shared activity list. One Claude call per
        // poll-close (cache TTL 7d covers reminders too). Failures are
        // non-fatal — UI + email gracefully omit activities section.
        try {
          const activities = await loadActivitiesForPoll({ env, poll });
          console.log(
            `[cron] activities pre-fetch for ${poll.slug}: reason=${activities.reason} thisWeek=${activities.activities.thisWeek.length} alwaysGreat=${activities.activities.alwaysGreat.length} provider=${activities.provider.name}`
          );
        } catch (err) {
          console.error(`[cron] activities pre-fetch failed for ${poll.slug}`, err);
        }

        // Phase 8: per-participant close-summary emails (fire-and-forget).
        // Silently skipped when WHENWEGO_RESEND_API_KEY is unset.
        const allProfiles = await stub.getAllProfiles();
        const profilesByToken = new Map(
          (allProfiles as Array<{ token: string } & ParticipantProfile>).map(
            (p) => [p.token, p]
          )
        );
        await fanOutCloseSummaryEmails({
          env,
          poll,
          overlap,
          profilesByToken,
          ctx,
          awaitAll: false,
        });
      }
    } catch (err) {
      console.error(`[cron] error processing poll ${poll.slug}`, err);
    }
  }

  // ─── helper: see fetchFlightsForCloseFanout below ───────────────────

  // Feature 10: pre-vote reminder. 3 days before pollCloseAt, for every
  // participant who hasn't voted yet, send a reminder email.
  await pollVoteReminderCheck(env, polls, now, ctx);

  // Phase 9: reminder-check loop. Walks every poll, asks the DO for
  // poll_meta.trip_start, and for each reminder type that's currently inside
  // its ±1h window, fires the fan-out via ctx.waitUntil. Idempotency lives in
  // the fan-out itself (reminders_sent table) — no need to track here.
  for (const poll of polls) {
    try {
      const stub = env.WHENWEGO_POLL_DO.get(
        env.WHENWEGO_POLL_DO.idFromName(poll.slug)
      ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

      const tripStart = await stub.getMeta('trip_start');
      if (!tripStart) continue; // either not closed or no viable trip

      for (const type of ALL_REMINDER_TYPES) {
        if (!isInReminderWindow(now, tripStart as string, type)) continue;
        ctx.waitUntil(
          fanOutReminders({ env, poll, type, ctx }).catch((err) => {
            console.error(
              `[cron] reminder fan-out failed for ${poll.slug}/${type}`,
              err
            );
          })
        );
      }
    } catch (err) {
      console.error(`[cron] reminder loop error for ${poll.slug}`, err);
    }
  }
}

/**
 * Phase 5 — fetch + cache flights for every participant in parallel.
 * Promise.allSettled so a single slow/failed Amadeus call doesn't block
 * the others. When Amadeus is not configured, loadFlightsForParticipant
 * returns { reason: 'not_configured', flights: [] } synchronously — no
 * network call — so this is effectively a no-op without a key.
 */
async function fetchFlightsForCloseFanout(
  env: Env,
  poll: Poll
): Promise<void> {
  const results = await Promise.allSettled(
    poll.participants.map((p) =>
      loadFlightsForParticipant({ env, poll, token: p.token })
    )
  );
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'rejected') {
      failed++;
      continue;
    }
    if (r.value.reason === 'ok') ok++;
    else skipped++;
  }
  console.log(
    `[cron] flights pre-fetch for ${poll.slug}: ok=${ok} skipped=${skipped} failed=${failed}`
  );
}

/**
 * Feature 10: send a "please vote" reminder email 3 days before poll closes,
 * to every participant who has NOT voted yet. Idempotency key:
 * `poll_vote_reminder_sent` in poll_meta (set once per poll).
 */
async function pollVoteReminderCheck(
  env: Env,
  polls: Poll[],
  now: number,
  ctx: ExecutionContext
): Promise<void> {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const WINDOW_MS = 2 * 60 * 60 * 1000; // ±2h window so we fire once per cron cycle

  const siteUrl =
    (env.WHENWEGO_SITE_URL && env.WHENWEGO_SITE_URL.replace(/\/$/, '')) ||
    'http://localhost:4321';

  for (const poll of polls) {
    try {
      const closeAtMs = Date.parse(poll.pollCloseAt);
      if (!Number.isFinite(closeAtMs)) continue;

      // Is the poll closing in approx 3 days from now (within ±2h window)?
      const msUntilClose = closeAtMs - now;
      if (msUntilClose < THREE_DAYS_MS - WINDOW_MS || msUntilClose > THREE_DAYS_MS + WINDOW_MS) {
        continue;
      }

      const stub = env.WHENWEGO_POLL_DO.get(
        env.WHENWEGO_POLL_DO.idFromName(poll.slug)
      ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

      // Already closed? Skip.
      const alreadyClosed = await stub.isClosed();
      if (alreadyClosed) continue;

      // Idempotency: only send once per poll
      const alreadySent = await stub.getMeta('poll_vote_reminder_sent');
      if (alreadySent) continue;

      // Mark as sent immediately to prevent parallel cron ticks from double-sending.
      await stub.setMeta('poll_vote_reminder_sent', String(now));

      // Get voter status to find who hasn't voted
      const voterStatus = (await stub.getVoterStatus()) as Array<{
        token: string;
        vote_count: number;
      }>;
      const votedTokens = new Set(voterStatus.filter((v) => v.vote_count > 0).map((v) => v.token));

      // Get profiles for email addresses
      const allProfiles = (await stub.getAllProfiles()) as Array<
        { token: string } & ParticipantProfile
      >;
      const profilesByToken = new Map(allProfiles.map((p) => [p.token, p]));

      const destination = poll.destination ?? poll.title;
      const closesOn = poll.pollCloseAt.slice(0, 10);

      for (const participant of poll.participants) {
        if (votedTokens.has(participant.token)) continue; // already voted

        const profile = profilesByToken.get(participant.token);
        if (!profile?.email) continue; // no email to send to

        const pageUrl = `${siteUrl}/${poll.slug}/${participant.token}/`;
        const subject = `⏰ Nur noch 3 Tage: Abstimmen für ${destination}`;
        const text = [
          `Hey ${participant.name},`,
          '',
          `Nur noch 3 Tage bis die Abstimmung für "${poll.title}" schließt (${closesOn}).`,
          '',
          `Bitte stimm jetzt ab: ${pageUrl}`,
          '',
          '– Das when-we-go Team',
        ].join('\n');
        const html = `
          <p>Hey <strong>${participant.name}</strong>,</p>
          <p>Nur noch <strong>3 Tage</strong> bis die Abstimmung für
          <em>${poll.title}</em> schließt (${closesOn}).</p>
          <p><a href="${pageUrl}" style="display:inline-block;padding:12px 24px;background:#0066cc;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">Jetzt abstimmen →</a></p>
          <p style="color:#888;font-size:12px;">Ziel: ${destination}</p>
        `.trim();

        ctx.waitUntil(
          sendEmail(env, { to: profile.email, subject, html, text }).then((res) => {
            console.log(
              `[cron][vote-reminder] ${poll.slug} → ${participant.name}: ok=${res.ok} skipped=${res.skipped}`
            );
          }).catch((err) => {
            console.error(`[cron][vote-reminder] send failed for ${participant.name}`, err);
          })
        );
      }
    } catch (err) {
      console.error(`[cron][vote-reminder] error for ${poll.slug}`, err);
    }
  }
}

// Re-export type used inside the helper signature to keep the import surface tidy.
export type { Overlap };
