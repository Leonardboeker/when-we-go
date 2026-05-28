// worker/scheduled.ts
// Hourly cron — for each poll, auto-close if pollCloseAt has passed and the DO
// isn't already marked closed. Cron expression "0 * * * *" set in wrangler.toml.
//
// Logic per CONTEXT A-06:
//   1. Walk polls in WHENWEGO_POLLS_JSON
//   2. Skip if poll_meta.closed_at already set
//   3. Skip if now < pollCloseAt
//   4. Open poll's DO → compute overlap → closeNow() → notify (idempotent)
import type { Env, WhenWeGoPollDO, VoteRecord } from './durable-object';
import { loadPolls } from './lib/polls-config';
import { computeOverlap, type VoteRow } from './lib/overlap';
import { notifyPollClose } from './lib/notify-pipeline';

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
      if (now < closeAtMs) continue; // not yet due

      const stub = env.WHENWEGO_POLL_DO.get(
        env.WHENWEGO_POLL_DO.idFromName(poll.slug)
      ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

      const alreadyClosed = await stub.isClosed();
      if (alreadyClosed) continue;

      const allVotes = (await stub.getAllVotes()) as VoteRecord[];
      const overlap = computeOverlap(
        poll,
        allVotes.map((v) => ({ token: v.token, date: v.date, state: v.state })) as VoteRow[]
      );
      const { closedAt } = await stub.closeNow(JSON.stringify(overlap));
      console.log(`[cron] closed ${poll.slug} at ${new Date(closedAt).toISOString()}`);

      // Idempotency: only notify if not already notified.
      const notifiedAt = await stub.getMeta('close_notified_at');
      if (!notifiedAt) {
        await stub.setMeta('close_notified_at', String(closedAt));
        ctx.waitUntil(
          notifyPollClose(env, { pollSlug: poll.slug, overlap }).catch((err) => {
            console.error(`[cron] pollClose notify failed for ${poll.slug}`, err);
          })
        );
      }
    } catch (err) {
      console.error(`[cron] error processing poll ${poll.slug}`, err);
    }
  }
}
