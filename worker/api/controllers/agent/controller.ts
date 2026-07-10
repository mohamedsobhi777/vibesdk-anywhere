import { BaseController } from '../baseController';
import { generateId } from '../../../utils/idGenerator';
import { BehaviorType, ProjectType } from '../../../agents/core/types';
import { getBehaviorTypeForProject } from '../../../agents/core/features';
import {
    AgentBootstrapResponse,
    CodeGenArgs,
    MAX_AGENT_QUERY_LENGTH,
} from './types';
import { SecurityError, SecurityErrorType } from 'shared/types/errors';
import { RouteContext } from '../../types/route-context';
import { AppService } from '../../../database';
import { AgentSessionService } from '../../../database/services/AgentSessionService';
import { mintSessionJwt } from '../../../services/auth/sessionJwt';
import { bootAgentSandbox, getAgentPreviewUrl } from '../../../services/sandbox/agentSandboxBoot';
import { createLogger } from '../../../logger';

const resolveBehaviorType = (body: CodeGenArgs): BehaviorType => {
    if (body.behaviorType) return body.behaviorType;
    // Defer to the feature-definitions registry (DEFAULT_FEATURE_DEFINITIONS)
    // so the single source of truth for "what engine drives this project
    // type" lives alongside the rest of the feature config.
    return getBehaviorTypeForProject(body.projectType ?? 'app');
};

const resolveProjectType = (body: CodeGenArgs): ProjectType | 'auto' => {
    return body.projectType || 'auto';
};


/**
 * CodingAgentController to handle all code generation related endpoints
 */
export class CodingAgentController extends BaseController {
    static logger = createLogger('CodingAgentController');
    /**
     * Create the app + agent session rows and boot the Superserve agent
     * sandbox for this chat. Returns a bootstrap payload the browser uses
     * to join the session's Supabase Realtime channel directly.
     */
    static async startCodeGeneration(request: Request, env: Env, _: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            this.logger.info('Starting code generation process');

            // Parse the query from the request body
            let body: CodeGenArgs;
            try {
                body = await request.json() as CodeGenArgs;
            } catch (error) {
                return CodingAgentController.createErrorResponse(`Invalid JSON in request body: ${JSON.stringify(error, null, 2)}`, 400);
            }

            const query = body.query;
            if (typeof query !== 'string' || query.trim().length === 0) {
                return CodingAgentController.createErrorResponse('Missing "query" field in request body', 400);
            }
            if (query.length > MAX_AGENT_QUERY_LENGTH) {
                return CodingAgentController.createErrorResponse(
                    new SecurityError(
                        SecurityErrorType.INVALID_INPUT,
                        `Prompt too large (${query.length} characters). Maximum allowed is ${MAX_AGENT_QUERY_LENGTH} characters.`,
                        413,
                    ),
                    413,
                );
            }

            // Auth is enforced by the `setAuthLevel(AuthConfig.authenticated)` route middleware.
            const user = context.user!;

            const agentId = generateId();
            const sessionId = agentId;

            await new AppService(env).createApp({
                id: agentId,
                title: query.slice(0, 100) || 'Untitled App',
                originalPrompt: query,
                userId: user.id,
                status: 'generating',
            });

            await new AgentSessionService(env).createAgentSession({
                sessionId,
                agentId,
                userId: user.id,
                initArgs: {
                    query,
                    projectType: resolveProjectType(body),
                    behaviorType: resolveBehaviorType(body),
                },
            });

            const token = await mintSessionJwt(sessionId, env);

            // The Vercel ExecutionContext stub no-ops `waitUntil`, so the
            // sandbox boot must be awaited inline rather than deferred.
            let previewUrl: string | null = null;
            try {
                const boot = await bootAgentSandbox({ sessionId, agentId, sessionJwt: token, env });
                previewUrl = boot.previewUrl;
                await new AgentSessionService(env).updateSandboxId(sessionId, boot.sandboxId);
            } catch (error) {
                this.logger.error('Agent sandbox boot failed', error);
                // Known limitation for this thin vertical: apps.status has no
                // 'failed' value, so the app row is left in 'generating'.
                return CodingAgentController.createErrorResponse('Failed to boot agent sandbox', 502);
            }

            return CodingAgentController.createSuccessResponse<AgentBootstrapResponse>({
                agentId,
                sessionId,
                realtimeChannel: `session:${sessionId}`,
                previewUrl,
                token,
            });
        } catch (error) {
            this.logger.error('Error starting code generation', error);
            return CodingAgentController.handleError(error, 'start code generation');
        }
    }

    /**
     * Reconnect to an existing agent session. Mints a fresh session JWT and
     * resolves the session's Realtime channel + current preview URL so the
     * browser can rejoin an in-progress or completed generation.
     */
    static async connectToAgent(_request: Request, env: Env, _: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            // 1:1 mapping between agent and session for this vertical.
            const sessionId = agentId;
            const session = await new AgentSessionService(env).getAgentSession(sessionId);
            if (!session) {
                return CodingAgentController.createErrorResponse('Agent session not found', 404);
            }

            const token = await mintSessionJwt(sessionId, env);

            let previewUrl: string | null = null;
            if (session.sandboxId) {
                try {
                    previewUrl = await getAgentPreviewUrl(session.sandboxId, env);
                } catch (error) {
                    this.logger.warn('Failed to resolve agent preview url', { sessionId, error });
                }
            }

            return CodingAgentController.createSuccessResponse<AgentBootstrapResponse>({
                agentId,
                sessionId,
                realtimeChannel: `session:${sessionId}`,
                previewUrl,
                token,
            });
        } catch (error) {
            this.logger.error('Error connecting to agent', error);
            return CodingAgentController.handleError(error, 'connect to agent');
        }
    }
}
