// worker/lib/push-fanout.ts
// #9 — fan a "poll closed" Web Push out to every stored subscription for a poll.
// Best-effort: VAPID-unset → no-op; dead endpoints (404/410) are pruned; any
// error on one subscription never affects the others or the close flow.
import type { Env, WhenWeGoPollDO } from '../durable-object';
import type { Poll } from './polls-config';
import type { Overlap } from './overlap';
import { sendPush } from './webpush.ts';

export async function fanOutClosePush(args: {
  env: Env;
  stub: DurableObjectStub<WhenWeGoPollDO>;
  poll: Poll;
  overlap: Overlap | null;
  siteUrl: string;
}): Promise<void> {
  const { env, stub, poll, overlap, siteUrl } = args;
  if (!env.WHENWEGO_VAPID_PUBLIC_KEY || !env.WHENWEGO_VAPID_PRIVATE_KEY) return;

  let subs: Array<{ endpoint: string; token: string; subJson: string }>;
  try {
    subs = await stub.getPushSubscriptions();
  } catch {
    return;
  }
  if (!subs.length) return;

  const ranges = overlap?.ranges ?? [];
  const best = ranges.find((r) => r.tier === 'perfect') || ranges.find((r) => r.tier === 'withEffort') || null;
  const dest = poll.destination ?? poll.title;
  const payload = {
    title: '🎉 Termin steht — ' + dest,
    body: best
      ? 'Beste Daten: ' + best.start + ' → ' + best.end + '. Tipp auf die Benachrichtigung für Flüge & Hotels.'
      : 'Die Abstimmung ist beendet — schau dir die Ergebnisse an.',
    url: siteUrl.replace(/\/$/, '') + '/' + poll.slug,
    tag: 'wwg-close-' + poll.slug,
  };

  await Promise.allSettled(
    subs.map(async (s) => {
      const res = await sendPush(env, s.subJson, payload);
      if (res.status === 404 || res.status === 410) {
        try { await stub.removePushSubscription(s.endpoint); } catch { /* ignore */ }
      }
    })
  );
}
