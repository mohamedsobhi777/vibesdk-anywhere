import { BaseSandboxService } from "./BaseSandboxService";

let sandboxServiceFactoryOverride: ((sessionId: string, agentId: string) => BaseSandboxService) | null = null;

/**
 * Override hook the runtime uses to supply its BaseSandboxService
 * implementation. The standalone Bun agent runtime installs
 * `LocalSandboxService` here (see agent-runtime/src/standaloneAgent.ts) before
 * any sandbox call is made. There is no built-in default: the Cloudflare
 * Containers client (`SandboxSdkClient`) was removed with the rest of the CF
 * stack, so a runtime that reaches sandbox code without installing an override
 * is a wiring bug, surfaced loudly below rather than silently no-op'd.
 */
export function setSandboxServiceFactory(factory: (sessionId: string, agentId: string) => BaseSandboxService): void {
    sandboxServiceFactoryOverride = factory;
}

/**
 * Resolves the runtime's sandbox service via the installed override.
 * Kept async because every caller already awaits it (DeploymentManager.getClient,
 * BaseCodingBehavior.getSandboxServiceClient) and to preserve the call-site
 * contract from when implementations were dynamically imported.
 */
export async function getSandboxService(sessionId: string, agentId: string): Promise<BaseSandboxService> {
    if (sandboxServiceFactoryOverride) {
        return sandboxServiceFactoryOverride(sessionId, agentId);
    }
    throw new Error(
        'No sandbox service is configured: the runtime must install one via ' +
        'setSandboxServiceFactory() before requesting a sandbox (the standalone ' +
        'agent runtime installs LocalSandboxService at boot).',
    );
}