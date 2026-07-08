import { describe, expect, it } from 'bun:test';
import { createApp } from 'worker/app';

/**
 * Proves `createApp` (worker/app.ts) is portable to a plain Node/Bun
 * runtime with no `cloudflare:workers` module available - the exact
 * constraint a Vercel Node serverless function runs under. Runs via
 * `bun test` (a genuine non-workerd runtime), not the
 * `@cloudflare/vitest-pool-workers` pool the rest of the worker test suite
 * uses, since that pool runs inside workerd where `cloudflare:workers`
 * always resolves and would mask the exact failure this test exists to
 * catch.
 */
const fakeEnv = {
	ENVIRONMENT: 'test',
	CUSTOM_DOMAIN: 'localhost',
} as unknown as Env;

describe('createApp on a plain-object env (Vercel/Node)', () => {
	it('does not throw when constructed without a cloudflare:workers runtime', () => {
		expect(() => createApp(fakeEnv)).not.toThrow();
	});

	it('responds 200 with the health JSON for GET /api/health', async () => {
		const app = createApp(fakeEnv);
		const res = await app.request('/api/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});
});
