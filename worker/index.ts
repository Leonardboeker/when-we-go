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
import { handlePoll } from './handlers/poll';
import { handleProfile } from './handlers/profile';
import { handleAdminPoll } from './handlers/admin-poll';
import { handleAdminClose } from './handlers/admin-close';
import { handleIcal, handlePublicIcal } from './handlers/ical';
import { handleAdminResendSummary } from './handlers/admin-resend-summary';
import { handleAdminReminderStatus } from './handlers/admin-reminders';
import { handleAdminSendReminder } from './handlers/admin-send-reminder';
import { handleAdminClearReminder } from './handlers/admin-clear-reminder';
import { handleAdminCostSplit } from './handlers/admin-cost-split';
import { handleAdminExportPaymeback } from './handlers/admin-export-paymeback';
import { handleScheduled } from './scheduled';

export { WhenWeGoPollDO };

const router = new Router();

router.get('/api/health', (req, _env, _ctx) => {
  const env = _env as Env;
  // Phase number reflects the most-recent shipped phase. Bumped 9 → 10.
  return jsonResponse({ ok: true, phase: 10 }, { status: 200 }, req, env);
});

router.get('/api/poll', (req, env, ctx) =>
  handlePoll(req, env as Env, ctx)
);
router.post('/api/vote', (req, env, ctx) =>
  handleVote(req, env as Env, ctx)
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
      console.error('[worker] handler error', err);
      return errorResponse(
        err instanceof Error ? err.message : 'Internal error',
        500,
        req,
        env
      );
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
