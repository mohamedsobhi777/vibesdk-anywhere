/**
 * Minimal test worker entry point for the vitest-pool-workers runtime.
 * The Cloudflare deployment path and its Durable Objects were removed, so this
 * exports no DOs — it exists only to give the workerd test pool a module to
 * load and to wire the runtime-env seam.
 */
import { env as workerGlobalEnv } from 'cloudflare:workers';
import { setRuntimeEnv } from '../worker/utils/runtimeEnv';
setRuntimeEnv(workerGlobalEnv);

export default {
	async fetch() {
		return new Response('Test worker');
	},
};
