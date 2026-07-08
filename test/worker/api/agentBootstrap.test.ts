import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { CodingAgentController } from '../../../worker/api/controllers/agent/controller';
import { AppService } from '../../../worker/database';
import { AgentSessionService } from '../../../worker/database/services/AgentSessionService';
import * as sessionJwtModule from '../../../worker/services/auth/sessionJwt';
import * as agentSandboxBootModule from '../../../worker/services/sandbox/agentSandboxBoot';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';
import type { RouteContext } from '../../../worker/api/types/route-context';
import type { ApiResponse } from '../../../worker/api/controllers/types';
import type { AgentBootstrapResponse } from '../../../worker/api/controllers/agent/types';
import type { App as AppRow, AgentSession } from '../../../worker/database/schema';

/**
 * Unit tests for `POST /api/agent` -> `CodingAgentController.startCodeGeneration`,
 * rewritten to create the app + agent_session rows, mint a session JWT, and
 * boot the Superserve agent sandbox rather than driving the old Durable
 * Object NDJSON stream. Collaborators are spied on their real class
 * prototypes / module namespace (imported here via the same relative-path
 * shape the controller itself uses) rather than `vi.mock`'d, because
 * `@cloudflare/vitest-pool-workers` resolves the `worker/*` tsconfig alias
 * and a relative import of the same file to two distinct module instances
 * (see the header comment in test/worker/database/agentSessionService.test.ts) -
 * mixing alias- and relative-style imports here would let a spy silently
 * miss the controller's own call.
 */

const MAX_AGENT_QUERY_LENGTH = 20_000;

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

function makeContext(userId = 'user_1'): RouteContext {
    return {
        user: { id: userId, email: 'u@e.com' },
        sessionId: null,
        config: {},
        pathParams: {},
        queryParams: new URLSearchParams(),
    } as unknown as RouteContext;
}

function makeRequest(body: unknown): Request {
    return new Request('https://example.com/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function fakeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        sessionId: 'session-placeholder',
        agentId: 'agent-placeholder',
        userId: null,
        status: 'provisioning',
        initArgs: null,
        sandboxId: null,
        lastActivityAt: now,
        createdAt: now,
        ...overrides,
    };
}

describe('POST /api/agent -> CodingAgentController.startCodeGeneration', () => {
    let createAppSpy: MockInstance<(appData: import('../../../worker/database/schema').NewApp) => Promise<AppRow>>;
    let createAgentSessionSpy: MockInstance<AgentSessionService['createAgentSession']>;
    let updateSandboxIdSpy: MockInstance<AgentSessionService['updateSandboxId']>;
    let mintSessionJwtSpy: MockInstance<typeof sessionJwtModule.mintSessionJwt>;
    let bootAgentSandboxSpy: MockInstance<typeof agentSandboxBootModule.bootAgentSandbox>;

    beforeEach(() => {
        createAppSpy = vi
            .spyOn(AppService.prototype, 'createApp')
            .mockImplementation(async (appData) => appData as unknown as AppRow);

        createAgentSessionSpy = vi
            .spyOn(AgentSessionService.prototype, 'createAgentSession')
            .mockImplementation(async (input) =>
                fakeAgentSession({
                    sessionId: input.sessionId,
                    agentId: input.agentId,
                    userId: input.userId ?? null,
                    initArgs: input.initArgs ?? null,
                }),
            );

        updateSandboxIdSpy = vi.spyOn(AgentSessionService.prototype, 'updateSandboxId').mockResolvedValue(undefined);

        mintSessionJwtSpy = vi.spyOn(sessionJwtModule, 'mintSessionJwt').mockResolvedValue('mock.session.jwt');

        bootAgentSandboxSpy = vi.spyOn(agentSandboxBootModule, 'bootAgentSandbox').mockResolvedValue({
            sandboxId: 'sb_1',
            previewUrl: 'https://preview.example',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates the app + agent session, boots the sandbox, and returns the bootstrap envelope', async () => {
        const response = await CodingAgentController.startCodeGeneration(
            makeRequest({ query: 'build a todo app' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<AgentBootstrapResponse>;
        expect(json.success).toBe(true);
        const data = json.data as AgentBootstrapResponse;

        expect(data.agentId).toBe(data.sessionId);
        expect(data.realtimeChannel).toBe(`session:${data.sessionId}`);
        expect(data.token).toBe('mock.session.jwt');
        expect(data.previewUrl).toBe('https://preview.example');

        // createApp composed with the right app row before the session/sandbox exist
        expect(createAppSpy).toHaveBeenCalledTimes(1);
        expect(createAppSpy).toHaveBeenCalledWith({
            id: data.agentId,
            title: 'build a todo app',
            originalPrompt: 'build a todo app',
            userId: 'user_1',
            status: 'generating',
        });

        // createAgentSession composed with the resolved project/behavior type
        expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
        expect(createAgentSessionSpy).toHaveBeenCalledWith({
            sessionId: data.sessionId,
            agentId: data.agentId,
            userId: 'user_1',
            initArgs: {
                query: 'build a todo app',
                projectType: 'auto',
                behaviorType: 'think',
            },
        });

        // mintSessionJwt scoped to the new session, then handed to the sandbox boot
        expect(mintSessionJwtSpy).toHaveBeenCalledWith(data.sessionId, FAKE_ENV);
        expect(bootAgentSandboxSpy).toHaveBeenCalledWith({
            sessionId: data.sessionId,
            agentId: data.agentId,
            sessionJwt: 'mock.session.jwt',
            env: FAKE_ENV,
        });

        // sandboxId persisted back onto the session row after boot succeeds
        expect(updateSandboxIdSpy).toHaveBeenCalledWith(data.sessionId, 'sb_1');
    });

    it('returns 400 and creates nothing when query is empty', async () => {
        const response = await CodingAgentController.startCodeGeneration(
            makeRequest({ query: '' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(createAppSpy).not.toHaveBeenCalled();
        expect(createAgentSessionSpy).not.toHaveBeenCalled();
    });

    it('returns 413 and creates nothing when query exceeds MAX_AGENT_QUERY_LENGTH', async () => {
        const response = await CodingAgentController.startCodeGeneration(
            makeRequest({ query: 'a'.repeat(MAX_AGENT_QUERY_LENGTH + 1) }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(413);
        expect(createAppSpy).not.toHaveBeenCalled();
    });

    it('returns 502 (not a success envelope) when the sandbox boot fails', async () => {
        bootAgentSandboxSpy.mockRejectedValueOnce(new Error('boot failed'));

        const response = await CodingAgentController.startCodeGeneration(
            makeRequest({ query: 'build a todo app' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(502);
        const json = (await response.json()) as ApiResponse<AgentBootstrapResponse>;
        expect(json.success).toBe(false);
        expect(json.data).toBeUndefined();

        // the row was created before boot was attempted, but never gets a sandboxId
        expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
        expect(updateSandboxIdSpy).not.toHaveBeenCalled();
    });
});
