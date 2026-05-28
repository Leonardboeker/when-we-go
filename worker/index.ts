// worker/index.ts
// Main fetch + scheduled entry points for the when-we-go Worker.
//
// Routes (Phase 2):
//   GET  /api/health             health probe — smoke-test target
//   GET  /api/poll               participant's vote state + poll meta + (post-close) overlap
//   POST /api/vote               bulk-replace participant's votes
//   GET  /api/admin/poll         organiser aggregate view
//   POST /api/admin/close        force-close (organiser-triggered)
//
// Cron: hourly auto-close per wrangler.toml.
import { WhenWeGoPollDO, type Env } from './durable-object';
import { Router } from './lib/router';
import { corsHeaders, errorResponse, jsonResponse } from './lib/cors';
import { handleVote } from './handlers/vote';
import { handlePoll } from './handlers/poll';
import { handleAdminPoll } from './handlers/admin-poll';
import { handleAdminClose } from './handlers/admin-close';
import { handleScheduled } from './scheduled';

export { WhenWeGoPollDO };

const router = new Router();

router.get('/api/health', (req, _env, _ctx) => {
  const env = _env as Env;
  return jsonResponse({ ok: true, phase: 2 }, { status: 200 }, req, env);
});

router.get('/api/poll', (req, env, ctx) =>
  handlePoll(req, env as Env, ctx)
);
router.post('/api/vote', (req, env, ctx) =>
  handleVote(req, env as Env, ctx)
);
router.get('/api/admin/poll', (req, env, ctx) =>
  handleAdminPoll(req, env as Env, ctx)
);
router.post('/api/admin/close', (req, env, ctx) =>
  handleAdminClose(req, env as Env, ctx)
);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight — always allowed.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }

    try {
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
