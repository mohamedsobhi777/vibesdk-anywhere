import { describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { StandaloneAgent } from '../src/standaloneAgent';
import { buildEnvAdapter } from '../src/envAdapter';
import { setTemplateSource, resetTemplateSourceForTests } from 'worker/services/sandbox/templateSource';

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
            workspaceDir: '/tmp/supervibe-test-s1',
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
            workspaceDir: '/tmp/supervibe-test-s2',
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

    it('initializes the project from a boot query so generation can start', async () => {
        const f = fakes();
        // Empty catalog → resolveTemplateInfo falls back to the from-scratch
        // baseline, so no template zip needs to be fetched/parsed. The point is
        // that a boot query now reaches behavior.initialize() and seeds state —
        // previously the query was dropped and the first generate_all 404'd.
        setTemplateSource({
            getCatalog: async () => [],
            getZip: async () => new ArrayBuffer(0),
        });
        mkdirSync('/tmp/supervibe-test-init', { recursive: true });
        try {
            const agent = await StandaloneAgent.boot({
                sessionId: 's-init',
                agentId: 'a-init',
                workspaceDir: '/tmp/supervibe-test-init',
                env: buildEnvAdapter({}),
                transport: f.transport as never,
                stateStore: f.stateStore as never,
                conversationStore: f.conversationStore as never,
                sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
                initArgs: { query: 'build a todo app' },
            });
            expect(agent.state.query).toBe('build a todo app');
            expect(agent.getBehavior().getBehavior()).toBe('agentic');
            expect(agent.state.templateName).toBe('scratch');
        } finally {
            resetTemplateSourceForTests();
        }
    });

    it('seeds active skills from init_args into fresh-session state, dropping malformed entries', async () => {
        const f = fakes();
        setTemplateSource({
            getCatalog: async () => [],
            getZip: async () => new ArrayBuffer(0),
        });
        mkdirSync('/tmp/supervibe-test-skills', { recursive: true });
        try {
            const agent = await StandaloneAgent.boot({
                sessionId: 's-skills',
                agentId: 'a-skills',
                workspaceDir: '/tmp/supervibe-test-skills',
                env: buildEnvAdapter({}),
                transport: f.transport as never,
                stateStore: f.stateStore as never,
                conversationStore: f.conversationStore as never,
                sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
                initArgs: {
                    query: 'build a todo app',
                    activeSkills: [
                        { id: 'skill-1', name: 'Design', description: 'Design rules', content: '# Rules' },
                        { id: 'bad', name: 'Broken' }, // missing description/content — dropped
                        'not-an-object',
                    ],
                },
            });
            expect(agent.state.activeSkills).toEqual([
                { id: 'skill-1', name: 'Design', description: 'Design rules', content: '# Rules' },
            ]);
        } finally {
            resetTemplateSourceForTests();
        }
    });

    it('rehydrated sessions keep the skills snapshot in persisted state and ignore later init_args edits', async () => {
        const f = fakes();
        const persistedSkill = { id: 'skill-old', name: 'Original', description: 'Frozen at creation', content: 'original content' };
        mkdirSync('/tmp/supervibe-test-skills-rehydrate', { recursive: true });
        const persistedState = {
            behaviorType: 'agentic',
            projectType: 'app',
            projectName: 'existing-project',
            query: 'build a todo app',
            sessionId: 's-rehydrate',
            hostname: '',
            blueprint: { title: 't', projectName: 'existing-project', description: 'd', colorPalette: [], frameworks: [], plan: [] },
            templateName: 'scratch', // skips template fetch on rehydrate
            generatedFilesMap: {},
            metadata: { agentId: 'a-rehydrate', userId: 'u-1' },
            shouldBeGenerating: false,
            commandsHistory: [],
            lastPackageJson: '',
            pendingUserInputs: [],
            projectUpdatesAccumulator: [],
            activeSkills: [persistedSkill],
            lastDeepDebugTranscript: null,
            mvpGenerated: false,
            reviewingInitiated: false,
            currentPlan: '',
        };
        const agent = await StandaloneAgent.boot({
            sessionId: 's-rehydrate',
            agentId: 'a-rehydrate',
            workspaceDir: '/tmp/supervibe-test-skills-rehydrate',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: { ...f.stateStore, load: async () => persistedState } as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
            initArgs: {
                query: 'build a todo app',
                activeSkills: [
                    { id: 'skill-new', name: 'Edited later', description: 'Must not apply', content: 'edited content' },
                ],
            },
        });
        expect(agent.state.activeSkills).toEqual([persistedSkill]);
    });

    it('maps an explicit think request to the agentic behavior instead of crashing', async () => {
        const f = fakes();
        // No query, so this exercises behavior selection only (no project
        // initialization / template fetch). 'think' has no dedicated standalone
        // behavior yet; it maps to the agentic loop rather than throwing.
        const agent = await StandaloneAgent.boot({
            sessionId: 's-3',
            agentId: 'a-3',
            workspaceDir: '/tmp/supervibe-test-s3',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
            initArgs: { behaviorType: 'think' },
        });
        expect(agent.getBehavior().getBehavior()).toBe('agentic');
    });
});

describe('StandaloneAgent.deployProject', () => {
    // "Deploy" has no Cloudflare Workers-for-Platforms primitive in the
    // standalone runtime (LocalSandboxService.deployToCloudflareWorkers() is
    // an always-failing stub). deployProject() must resolve to the sandbox
    // preview URL instead of routing through that stub, and must never
    // report success with a false "deployed to Cloudflare" claim.

    it('fails gracefully, without any Cloudflare-flavored claim, when no sandbox preview exists yet', async () => {
        const f = fakes();
        const agent = await StandaloneAgent.boot({
            sessionId: 's-4',
            agentId: 'a-4',
            workspaceDir: '/tmp/supervibe-test-s4',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
        });

        // Isolate deployProject()'s error handling from the real
        // isPreviewable()/template-details chain deployToSandbox() sits
        // behind (that chain has its own coverage elsewhere) — a bare-booted
        // agent with no files genuinely rejects with this same message via
        // BaseCodingBehavior.deployToSandbox(), reproduced here directly.
        agent.getBehavior().deployToSandbox = async () => {
            throw new Error('Project is not previewable');
        };

        const result = await agent.deployProject();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not previewable/i);

        const started = f.broadcasts.find((b) => b.type === 'cloudflare_deployment_started');
        const failed = f.broadcasts.find((b) => b.type === 'cloudflare_deployment_error');
        expect(started).toBeDefined();
        expect(failed).toBeDefined();
        expect(String(failed?.error)).not.toMatch(/cloudflare/i);
    });

    it('resolves a successful deploy to the live sandbox preview URL rather than a Cloudflare Workers claim', async () => {
        const f = fakes();
        const agent = await StandaloneAgent.boot({
            sessionId: 's-5',
            agentId: 'a-5',
            workspaceDir: '/tmp/supervibe-test-s5',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
        });

        // Isolate deployProject()'s URL-resolution behavior from the
        // sandbox/template pipeline behind deployToSandbox() — that pipeline
        // is exercised by DeploymentManager's own tests. Here we only assert
        // deployProject() honestly reports whatever preview URL
        // deployToSandbox() resolves to, via the existing broadcast wire
        // format the frontend already listens for.
        agent.getBehavior().deployToSandbox = async () => ({
            runId: 'sandbox-1',
            previewURL: 'https://sandbox-1.preview.example.com',
            tunnelURL: undefined,
        });

        const result = await agent.deployProject();

        expect(result.success).toBe(true);
        expect(result.url).toBe('https://sandbox-1.preview.example.com');

        const completed = f.broadcasts.find((b) => b.type === 'cloudflare_deployment_completed');
        expect(completed).toBeDefined();
        expect(completed?.deploymentUrl).toBe('https://sandbox-1.preview.example.com');
        expect(JSON.stringify(completed)).not.toMatch(/permanently|cloudflare workers/i);
    });
});
