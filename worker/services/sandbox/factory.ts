import { BaseSandboxService } from "./BaseSandboxService";
import { getRuntimeEnv } from "worker/utils/runtimeEnv";

let sandboxServiceFactoryOverride: ((sessionId: string, agentId: string) => BaseSandboxService) | null = null;

/**
 * Override hook so non-Workers runtimes (e.g. standalone Bun agent runtime)
 * can supply their own BaseSandboxService factory without this module's
 * Workers-only branch (and the Workers-only client modules it loads)
 * ever executing.
 */
export function setSandboxServiceFactory(factory: (sessionId: string, agentId: string) => BaseSandboxService): void {
    sandboxServiceFactoryOverride = factory;
}

/**
 * `SandboxSdkClient`/`RemoteSandboxServiceClient` are imported dynamically
 * (rather than statically at module top) so that under a non-Workers
 * runtime with an override installed, their modules — which read
 * `cloudflare:workers` at module scope, unresolvable under Bun — are never
 * loaded at all. `getSandboxService` is async solely to allow this; the
 * override branch below still resolves synchronously-fast (no real await),
 * and every caller in this codebase already awaits the result (see
 * DeploymentManager.getClient and BaseCodingBehavior.getSandboxServiceClient).
 */
export async function getSandboxService(sessionId: string, agentId: string): Promise<BaseSandboxService> {
    if (sandboxServiceFactoryOverride) {
        return sandboxServiceFactoryOverride(sessionId, agentId);
    }
    // Read env lazily, only on this Workers-only branch, via the
    // runtimeEnv seam (worker/utils/runtimeEnv.ts) rather than a top-level
    // `import { env } from 'cloudflare:workers'` — that import is
    // unresolvable under Bun and previously executed unconditionally at
    // module load, before any override hook could run. See
    // worker/services/sandbox/templateSource.ts for the same idiom.
    const env = getRuntimeEnv();
    if (env.SANDBOX_SERVICE_TYPE == 'runner') {
        console.log("[getSandboxService] Using runner service for sandboxing");
        const { RemoteSandboxServiceClient } = await import("./remoteSandboxService");
        return new RemoteSandboxServiceClient(sessionId);
    }
    console.log("[getSandboxService] Using sandboxsdk service for sandboxing");
    const { SandboxSdkClient } = await import("./sandboxSdkClient");
    return new SandboxSdkClient(sessionId, agentId);
}