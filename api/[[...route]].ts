import { createApp } from '../worker/app';

/**
 * Vercel Node.js Serverless Function entrypoint for the whole `/api/*`
 * surface. `createApp` (worker/app.ts) is the same portable Hono app the
 * Cloudflare Worker (worker/index.ts) serves; this runs it under Vercel's
 * Node runtime instead, via the Fetch API request/response convention
 * Vercel's Node functions support natively (a default-exported
 * `(request: Request) => Response | Promise<Response>`).
 *
 * `@hono/node-server`'s own `/vercel` adapter (`@hono/node-server/vercel`)
 * was removed in its v2 major (present through 1.19.x, gone as of 2.0.0 -
 * verified against the published npm metadata) in favor of Vercel's native
 * Web API support, and `hono/vercel`'s `handle` only forwards the request
 * (`(app) => (req) => app.fetch(req)`), dropping `env`/`ctx`. Hono route
 * handlers here read `env` via `c.env` and unconditionally read
 * `c.executionCtx` (see worker/api/honoAdapter.ts's `adaptController`), not
 * a closure, so both must be threaded through explicitly on every call, the
 * same way worker/index.ts's fetch handler does with the real Workers
 * `env`/`ctx` bindings - otherwise every controller-backed route throws
 * "This context has no ExecutionContext".
 */
export const config = { runtime: 'nodejs' };

const env = process.env as unknown as Env;
const app = createApp(env);

/**
 * Vercel Node functions have no isolate to keep alive past the response, so
 * there is no real equivalent of Workers' `waitUntil`/`passThroughOnException`.
 * `waitUntil` here just lets the promise run to completion and logs a
 * rejection instead of leaving it unhandled; nothing currently depends on
 * the response actually waiting for it.
 */
const executionContext: ExecutionContext = {
	waitUntil(promise: Promise<unknown>): void {
		promise.catch((error: unknown) => {
			console.error('[api] waitUntil task failed', error);
		});
	},
	passThroughOnException(): void {},
	props: undefined,
};

export default function handler(request: Request): Response | Promise<Response> {
	return app.fetch(request, env, executionContext);
}
