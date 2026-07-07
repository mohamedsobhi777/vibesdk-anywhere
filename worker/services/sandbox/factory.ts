import { SandboxSdkClient } from "./sandboxSdkClient";
import { RemoteSandboxServiceClient } from "./remoteSandboxService";
import { BaseSandboxService } from "./BaseSandboxService";
import { env } from 'cloudflare:workers'

let sandboxServiceFactoryOverride: ((sessionId: string, agentId: string) => BaseSandboxService) | null = null;

/**
 * Override hook so non-Workers runtimes (e.g. standalone Bun agent runtime)
 * can supply their own BaseSandboxService factory without this module's
 * Workers-only branches (and their 'cloudflare:workers' import) executing.
 */
export function setSandboxServiceFactory(factory: (sessionId: string, agentId: string) => BaseSandboxService): void {
    sandboxServiceFactoryOverride = factory;
}

export function getSandboxService(sessionId: string, agentId: string): BaseSandboxService {
    if (sandboxServiceFactoryOverride) {
        return sandboxServiceFactoryOverride(sessionId, agentId);
    }
    if (env.SANDBOX_SERVICE_TYPE == 'runner') {
        console.log("[getSandboxService] Using runner service for sandboxing");
        return new RemoteSandboxServiceClient(sessionId);
    }
    console.log("[getSandboxService] Using sandboxsdk service for sandboxing");
    return new SandboxSdkClient(sessionId, agentId);
}