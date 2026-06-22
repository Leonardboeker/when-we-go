// worker/index.ts
// Main fetch + scheduled entry points for the when-we-go Worker.
//
// Routes:
//   Phase 2:
//     GET  /api/health             health probe — smoke-test target
//     GET  /api/poll               participant's vote state + poll meta + (post-close) overlap
//     POST /api/vote               bulk-replace participant's votes
//     GET  /api/admin/poll         organiser aggregate view
//     POST /api/admin/close        force-close (organiser-triggered)
//   Phase 4:
//     POST /api/profile            set/update participant profile
//   Phase 8:
//     GET  /api/ical               personalised .ics (token-gated)
//     GET  /ical/<slug>.ics        public minimal .ics (no token)
//     POST /api/admin/resend-close-summary  re-fire close-summary emails
//   Phase 9:
//     GET  /api/admin/reminder-status  per-participant per-type sent status
//     POST /api/admin/send-reminder    force-fire a specific reminder type
//     POST /api/admin/clear-reminder   clear one reminder row (force re-send)
//   Phase 10:
//     GET  /api/admin/cost-split       per-participant split (stored + defaults)
//     POST /api/admin/cost-split       bulk update split rows
//     GET  /api/admin/export-paymeback pay-me-back-shaped JSON export
//
// Cron: hourly auto-close per wrangler.toml. Also drives the reminder cron
// (Phase 9, scheduled.ts) using the same trigger — no new cron required.
import { WhenWeGoPollDO, type Env } from './durable-object';
import { Router } from './lib/router';
import { corsHeaders, errorResponse, jsonResponse } from './lib/cors';
import { handleVote } from './handlers/vote';
import { handleComment } from './handlers/comment';
import { handlePushKey, handlePushSubscribe } from './handlers/push';
import { handlePoll } from './handlers/poll';
import { handleProfile } from './handlers/profile';
import { handleAdminPoll } from './handlers/admin-poll';
import { handleAdminClose } from './handlers/admin-close';
import { handleAdminReopen } from './handlers/admin-reopen';
import { handleAdminExport, handleAdminWipe } from './handlers/admin-data';
import { handleIcal, handlePublicIcal } from './handlers/ical';
import { handleAdminResendSummary } from './handlers/admin-resend-summary';
import { handleAdminReminderStatus } from './handlers/admin-reminders';
import { handleAdminSendReminder } from './handlers/admin-send-reminder';
import { handleAdminSendVoteReminder } from './handlers/admin-send-vote-reminder';
import { handleAdminClearReminder } from './handlers/admin-clear-reminder';
import { handleAdminCostSplit } from './handlers/admin-cost-split';
import { handleAdminExportPaymeback } from './handlers/admin-export-paymeback';
import { handleFlights } from './handlers/flights';
import { handleFlightsRefresh } from './handlers/flights-refresh';
import { handleAdminFlights } from './handlers/admin-flights';
import { handleHotels } from './handlers/hotels';
import { handleHotelsRefresh } from './handlers/hotels-refresh';
import { handleHotelVote } from './handlers/hotel-vote';
import { handleAdminHotelChoose } from './handlers/admin-hotel-choose';
import { handleActivities } from './handlers/activities';
import { handleActivitiesRefresh } from './handlers/activities-refresh';
import { handleScheduled } from './scheduled';

export { WhenWeGoPollDO };

const router = new Router();

router.get('/api/health', (req, _env, _ctx) => {
  const env = _env as Env;
  // Plain liveness probe — don't leak internal phase / version markers.
  return jsonResponse({ ok: true }, { status: 200 }, req, env);
});

router.get('/api/poll', (req, env, ctx) =>
  handlePoll(req, env as Env, ctx)
);
router.post('/api/vote', (req, env, ctx) =>
  handleVote(req, env as Env, ctx)
);
router.post('/api/comment', (req, env, ctx) =>
  handleComment(req, env as Env, ctx)
);
router.get('/api/push/key', (req, env, ctx) =>
  handlePushKey(req, env as Env, ctx)
);
router.post('/api/push/subscribe', (req, env, ctx) =>
  handlePushSubscribe(req, env as Env, ctx)
);
router.post('/api/profile', (req, env, ctx) =>
  handleProfile(req, env as Env, ctx)
);
router.get('/api/admin/poll', (req, env, ctx) =>
  handleAdminPoll(req, env as Env, ctx)
);
router.post('/api/admin/close', (req, env, ctx) =>
  handleAdminClose(req, env as Env, ctx)
);
router.post('/api/admin/reopen', (req, env, ctx) =>
  handleAdminReopen(req, env as Env, ctx)
);
router.get('/api/admin/export', (req, env, ctx) =>
  handleAdminExport(req, env as Env, ctx)
);
router.post('/api/admin/wipe', (req, env, ctx) =>
  handleAdminWipe(req, env as Env, ctx)
);
router.get('/api/ical', (req, env, ctx) =>
  handleIcal(req, env as Env, ctx)
);
router.post('/api/admin/resend-close-summary', (req, env, ctx) =>
  handleAdminResendSummary(req, env as Env, ctx)
);
router.get('/api/admin/reminder-status', (req, env, ctx) =>
  handleAdminReminderStatus(req, env as Env, ctx)
);
router.post('/api/admin/send-reminder', (req, env, ctx) =>
  handleAdminSendReminder(req, env as Env, ctx)
);
router.post('/api/admin/send-vote-reminder', (req, env, ctx) =>
  handleAdminSendVoteReminder(req, env as Env, ctx)
);
router.post('/api/admin/clear-reminder', (req, env, ctx) =>
  handleAdminClearReminder(req, env as Env, ctx)
);
// Phase 10 — split-costs + pay-me-back JSON export.
router.get('/api/admin/cost-split', (req, env, ctx) =>
  handleAdminCostSplit(req, env as Env, ctx)
);
router.post('/api/admin/cost-split', (req, env, ctx) =>
  handleAdminCostSplit(req, env as Env, ctx)
);
router.get('/api/admin/export-paymeback', (req, env, ctx) =>
  handleAdminExportPaymeback(req, env as Env, ctx)
);
// Phase 5 — flights (Amadeus). Graceful: when Amadeus keys unset, every
// response is 200 + { reason: 'not_configured', flights: [] }.
router.get('/api/flights', (req, env, ctx) =>
  handleFlights(req, env as Env, ctx)
);
router.post('/api/flights/refresh', (req, env, ctx) =>
  handleFlightsRefresh(req, env as Env, ctx)
);
router.get('/api/admin/flights', (req, env, ctx) =>
  handleAdminFlights(req, env as Env, ctx)
);
// Phase 6 — hotels (PROVIDER-ABSTRACTED). Same shape as flights but the
// shortlist is SHARED across the poll (one cache key per slug/date/guests).
router.get('/api/hotels', (req, env, ctx) =>
  handleHotels(req, env as Env, ctx)
);
router.post('/api/hotels/refresh', (req, env, ctx) =>
  handleHotelsRefresh(req, env as Env, ctx)
);
router.post('/api/hotel-vote', (req, env, ctx) =>
  handleHotelVote(req, env as Env, ctx)
);
router.post('/api/admin/hotel-choose', (req, env, ctx) =>
  handleAdminHotelChoose(req, env as Env, ctx)
);
// Phase 7 — activities (Anthropic Claude structured-output via tools API).
// Cache TTL 7 days; refresh 1/day per slug. Mock fallback when key unset.
router.get('/api/activities', (req, env, ctx) =>
  handleActivities(req, env as Env, ctx)
);
router.post('/api/activities/refresh', (req, env, ctx) =>
  handleActivitiesRefresh(req, env as Env, ctx)
);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight — always allowed.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }

    try {
      // Phase 8: dynamic path for `/ical/<slug>.ics`. Pattern-matched here
      // because the existing Router does exact path matching only.
      const url = new URL(req.url);
      if (req.method === 'GET' && /^\/ical\/[^/]+\.ics$/.test(url.pathname)) {
        return await handlePublicIcal(req, env, ctx);
      }

      const matched = await router.handle(req, env, ctx);
      if (matched) return matched;
    } catch (err) {
      // Log the real error server-side, but never leak the message (which can
      // contain provider responses, SQL fragments, stack traces) to clients.
      console.error('[worker] handler error', err);
      return errorResponse('Internal error', 500, req, env);
    }

    return errorResponse('Not found', 404, req, env);
  },

  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduled(event, env, ctx);
  },
};
