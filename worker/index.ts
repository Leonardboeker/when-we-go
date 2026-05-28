// worker/index.ts
// Phase 1 stub. The real vote API lives in Phase 2:
//   POST /api/poll/:slug/vote      cast/update a participant's votes
//   GET  /api/poll/:slug/state     organiser-only aggregated vote view
//   POST /api/poll/:slug/close     mark a poll closed (manual override)
//
// For now every /api/* request returns the same { phase: 1, ready: false }
// so any client polling the Worker during local dev gets a stable shape.
import { WhenWeGoPollDO, type Env } from './durable-object.js';

export { WhenWeGoPollDO };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default {
  async fetch(req: Request, _env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Phase 1: every /api/* path answers the same stub.
    if (pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({
          phase: 1,
          ready: false,
          message:
            'when-we-go Worker is in Phase 1 stub mode. Vote endpoints land in Phase 2.',
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders,
    });
  },
};
