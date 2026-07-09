import { describe, expect, it } from 'vitest';
import type { StructuredLogger } from 'worker/logger';
import type { AgentInfrastructure } from 'worker/agents/core/AgentCore';
import type { AgenticState } from 'worker/agents/core/state';
import type { ConversationState } from 'worker/agents/inferutils/common';
import type { WebSocketMessageData, WebSocketMessageType } from 'worker/api/websocketTypes';
import type { FileManager } from 'worker/agents/services/implementations/FileManager';
import type { DeploymentManager } from 'worker/agents/services/implementations/DeploymentManager';
import type { GitVersionControl } from 'worker/agents/git';
import { AgenticCodingBehavior } from 'worker/agents/core/behaviors/agentic';

interface RecordedBroadcast {
    type: string;
    data?: unknown;
}

/**
 * Minimal AgenticState: BaseCodingBehavior's constructor only reads
 * `sandboxInstanceId` and `behaviorType`; captureScreenshot itself never
 * touches state beyond env/getAgentId(), so the rest is filled with
 * innocuous placeholders and cast at the boundary.
 */
function makeFakeState(): AgenticState {
    return {
        behaviorType: 'agentic',
        projectType: 'app',
        projectName: 'test-project',
        query: 'build a test app',
        sessionId: 'session-1',
        hostname: '',
        blueprint: {},
        templateName: '',
        generatedFilesMap: {},
        conversationMessages: [],
        metadata: { agentId: 'agent-1', userId: 'user-1' },
        shouldBeGenerating: false,
        sandboxInstanceId: undefined,
        commandsHistory: [],
        lastPackageJson: '',
        pendingUserInputs: [],
        projectUpdatesAccumulator: [],
        lastDeepDebugTranscript: null,
        mvpGenerated: false,
        reviewingInitiated: false,
    } as unknown as AgenticState;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StructuredLogger;

/**
 * Fakes just enough of AgentInfrastructure for BaseCodingBehavior's
 * constructor plus captureScreenshot's own early-guard reads (env,
 * getAgentId, broadcast, logger). fileManager/deploymentManager/git are
 * never touched by captureScreenshot, so they're opaque stubs.
 */
function makeFakeInfrastructure(env: Env, broadcasts: RecordedBroadcast[]): AgentInfrastructure<AgenticState> {
    let state = makeFakeState();
    let conversation: ConversationState = { id: 'default', runningHistory: [], fullHistory: [] };

    return {
        get state() {
            return state;
        },
        setState(next: AgenticState) {
            state = next;
        },
        getWebSockets: () => [],
        broadcast<T extends WebSocketMessageType>(type: T, data?: WebSocketMessageData<T>) {
            broadcasts.push({ type, data });
        },
        getAgentId: () => 'agent-1',
        logger: () => noopLogger,
        env,
        setConversationState: (next: ConversationState) => {
            conversation = next;
        },
        getConversationState: () => conversation,
        addConversationMessage: () => {},
        clearConversation: () => {},
        fileManager: {} as unknown as FileManager,
        deploymentManager: {} as unknown as DeploymentManager,
        git: {} as unknown as GitVersionControl,
        exportGitObjects: async () => ({ gitObjects: [], query: '', hasCommits: false, templateDetails: null }),
    };
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
    return {
        DB: {},
        ...overrides,
    } as unknown as Env;
}

/** Runs `fn` with a fetch stub that fails the test if the network is touched. */
async function withNetworkGuard<T>(fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
        throw new Error('network should not be reached when screenshot capture is skipped');
    }) as typeof fetch;
    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

describe('BaseCodingBehavior.captureScreenshot — optional Cloudflare Browser Rendering capture', () => {
    it('skips gracefully (empty string, no throw, no broadcast) when both CF credentials are absent', async () => {
        const broadcasts: RecordedBroadcast[] = [];
        const env = makeEnv();
        const behavior = new AgenticCodingBehavior(makeFakeInfrastructure(env, broadcasts), 'app');

        const result = await withNetworkGuard(() => behavior.captureScreenshot('https://preview.example.com'));

        expect(result).toBe('');
        expect(broadcasts).toEqual([]);
    });

    it('skips gracefully when CLOUDFLARE_ACCOUNT_ID is absent but CLOUDFLARE_API_TOKEN is present', async () => {
        const broadcasts: RecordedBroadcast[] = [];
        const env = makeEnv({ CLOUDFLARE_API_TOKEN: 'token-only' });
        const behavior = new AgenticCodingBehavior(makeFakeInfrastructure(env, broadcasts), 'app');

        const result = await withNetworkGuard(() => behavior.captureScreenshot('https://preview.example.com'));

        expect(result).toBe('');
        expect(broadcasts).toEqual([]);
    });

    it('skips gracefully when CLOUDFLARE_API_TOKEN is absent but CLOUDFLARE_ACCOUNT_ID is present', async () => {
        const broadcasts: RecordedBroadcast[] = [];
        const env = makeEnv({ CLOUDFLARE_ACCOUNT_ID: 'account-only' });
        const behavior = new AgenticCodingBehavior(makeFakeInfrastructure(env, broadcasts), 'app');

        const result = await withNetworkGuard(() => behavior.captureScreenshot('https://preview.example.com'));

        expect(result).toBe('');
        expect(broadcasts).toEqual([]);
    });

    it('reaches the network (does not skip) once both CF credentials are configured', async () => {
        const broadcasts: RecordedBroadcast[] = [];
        const env = makeEnv({ CLOUDFLARE_ACCOUNT_ID: 'account-id', CLOUDFLARE_API_TOKEN: 'api-token' });
        const behavior = new AgenticCodingBehavior(makeFakeInfrastructure(env, broadcasts), 'app');

        const originalFetch = globalThis.fetch;
        let fetchCalled = false;
        let capturedUrl = '';
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            fetchCalled = true;
            capturedUrl = String(input);
            // Deliberately never resolves within this test: proving the gate
            // let execution reach the network call is enough, and it avoids
            // exercising captureScreenshot's real (multi-second) retry/backoff
            // loop, which is unrelated to what this test verifies.
            return new Promise<Response>(() => {});
        }) as typeof fetch;

        try {
            const capturePromise = behavior.captureScreenshot('https://preview.example.com');
            capturePromise.catch(() => {
                // Never settles in this test (fetch above never resolves);
                // guard against an unhandled-rejection warning regardless.
            });
            await Promise.resolve(); // let the microtask queue reach the fetch() call
            await Promise.resolve();
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(fetchCalled).toBe(true);
        expect(capturedUrl).toContain('browser-rendering/snapshot');
        expect(broadcasts.some((b) => b.type === 'screenshot_capture_started')).toBe(true);
    });
});
