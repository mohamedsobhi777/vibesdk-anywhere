import { describe, expect, it } from 'bun:test';
import { StandaloneAgent } from '../src/standaloneAgent';
import { buildEnvAdapter } from '../src/envAdapter';

function fakes() {
    const broadcasts: Array<Record<string, unknown>> = [];
    const persisted: unknown[] = [];
    return {
        broadcasts,
        persisted,
        transport: {
            ready: async () => {},
            broadcast: (m: Record<string, unknown>) => {
                broadcasts.push(m);
            },
            connection: {
                id: 'c1',
                send: (d: string) => {
                    broadcasts.push(JSON.parse(d));
                },
                url: null,
            },
            close: async () => {},
        },
        stateStore: {
            load: async () => null,
            persist: (s: unknown) => {
                persisted.push(s);
            },
            flush: async () => {},
        },
        conversationStore: {
            append: async () => {},
            loadAll: async () => [],
            clear: async () => {},
            replaceAll: async () => {},
        },
    };
}

describe('StandaloneAgent.boot', () => {
    it('initializes default state, persists it, and emits agent_connected', async () => {
        const f = fakes();
        const agent = await StandaloneAgent.boot({
            sessionId: 's-1',
            agentId: 'a-1',
            workspaceDir: '/tmp/vibesdk-test-s1',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
            initArgs: undefined, // no blueprint generation — bare boot
        });
        expect(agent.state.sessionId).toBe('s-1');
        const connected = f.broadcasts.find((b) => b.type === 'agent_connected');
        expect(connected).toBeDefined();
        expect(f.persisted.length).toBeGreaterThan(0);
    });

    it('setState persists through the store and updates the getter', async () => {
        const f = fakes();
        const agent = await StandaloneAgent.boot({
            sessionId: 's-2',
            agentId: 'a-2',
            workspaceDir: '/tmp/vibesdk-test-s2',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
        });
        const before = f.persisted.length;
        agent.setState({ ...agent.state, projectName: 'renamed' });
        expect(agent.state.projectName).toBe('renamed');
        expect(f.persisted.length).toBe(before + 1);
    });

    it('rejects think behavior init', async () => {
        const f = fakes();
        await expect(
            StandaloneAgent.boot({
                sessionId: 's-3',
                agentId: 'a-3',
                workspaceDir: '/tmp/vibesdk-test-s3',
                env: buildEnvAdapter({}),
                transport: f.transport as never,
                stateStore: f.stateStore as never,
                conversationStore: f.conversationStore as never,
                sandbox: {} as never,
                initArgs: { behaviorType: 'think', query: 'x' },
            }),
        ).rejects.toThrow(/think behavior is not supported/);
    });
});
