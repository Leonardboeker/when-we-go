// worker/lib/cors.ts
// CORS helper. Same-origin in prod (the static site + Worker share the apex domain
// via Cloudflare routes); allow http://localhost:4321 in dev so Astro's dev server
// can hit the local wrangler dev Worker at http://localhost:8787.
//
// Production strategy: we mirror the request's Origin header for any origin that
// matches the configured ALLOWED_ORIGINS env var (comma-separated). The default
// list always includes http://localhost:4321 so smoke tests + local dev work.

const DEFAULT_ALLOWED = ['http://localhost:4321', 'http://localhost:8787'];

export interface CorsEnv {
  ALLOWED_ORIGINS?: string;
}

export function corsHeaders(
  req: Request,
  env: CorsEnv,
  extra: Record<string, string> = {}
): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = new Set([
    ...DEFAULT_ALLOWED,
    ...(env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : []),
  ]);

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Organizer-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };

  if (origin && allowed.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (origin) {
    // Same-origin in prod — mirror back; cross-origin from unknown sources allowed
    // only if no Origin header is present (which is the case for same-origin fetches).
    headers['Access-Control-Allow-Origin'] = origin;
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
  req?: Request,
  env?: CorsEnv
): Response {
  const cors = req && env ? corsHeaders(req, env) : {};
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(
  message: string,
  status: number,
  req?: Request,
  env?: CorsEnv
): Response {
  return jsonResponse({ error: message }, { status }, req, env);
}
