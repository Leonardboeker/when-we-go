// worker/lib/router.ts
// Tiny request router. Pattern matching is exact (no params) — that's all the
// when-we-go API needs (every route is `/api/...` with query-string args).
// Returns null on no match so the caller can decide 404 response shape.

export type RouteHandler = (
  req: Request,
  env: unknown,
  ctx: ExecutionContext
) => Response | Promise<Response>;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';

interface Route {
  method: Method;
  path: string;
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler): this {
    return this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.add('POST', path, handler);
  }

  add(method: Method, path: string, handler: RouteHandler): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  async handle(
    req: Request,
    env: unknown,
    ctx: ExecutionContext
  ): Promise<Response | null> {
    const url = new URL(req.url);
    const match = this.routes.find(
      (r) => r.method === req.method && r.path === url.pathname
    );
    if (!match) return null;
    return await match.handler(req, env, ctx);
  }
}
