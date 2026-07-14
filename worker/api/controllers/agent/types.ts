import type { PreviewType } from "../../../services/sandbox/sandboxTypes";
import type { ImageAttachment } from '../../../types/image-attachment';
import type { BehaviorType, ProjectType } from '../../../agents/core/types';
import type { CredentialsPayload } from '../../../agents/inferutils/config.types';

export const MAX_AGENT_QUERY_LENGTH = 20_000;

export interface CodeGenArgs {
    query: string;
    language?: string;
    frameworks?: string[];
    selectedTemplate?: string;
    behaviorType?: BehaviorType;
    projectType?: ProjectType;
    images?: ImageAttachment[];

    /**
     * Optional AIModels id (e.g. "anthropic/claude-fable-5") chosen on the
     * front page. Applied to the main generation actions for this session;
     * invalid values are ignored and defaults apply.
     */
    selectedModel?: string;

    /** Optional ephemeral credentials (BYOK / gateway override) for sdk */
    credentials?: CredentialsPayload;
}

/**
 * Data structure for connectToExistingAgent response
 */
export interface AgentConnectionData {
    websocketUrl: string;
    agentId: string;
}

export type AgentPreviewResponse = PreviewType;

/**
 * Bootstrap payload returned by `POST /api/agent`: the app + agent session
 * have been created and the Superserve agent sandbox is booting/booted. The
 * browser uses `token` to join the private `realtimeChannel` over Supabase
 * Realtime.
 */
export interface AgentBootstrapResponse {
    agentId: string;
    sessionId: string;
    realtimeChannel: string; // === `session:${sessionId}`
    previewUrl: string | null;
    token: string; // session-scoped Supabase JWT; the browser uses it to join the private channel
}
