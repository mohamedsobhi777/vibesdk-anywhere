import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { ModelConfigService } from 'worker/database/services/ModelConfigService';
import { ModelProvidersService } from 'worker/database/services/ModelProvidersService';
import { buildDefaultModelConfigsInfo } from 'worker/database/services/modelConfigDefaults';
import { AIModels } from 'worker/agents/inferutils/config.types';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';
import { setRuntimeEnv } from 'worker/utils/runtimeEnv';

/**
 * `@cloudflare/vitest-pool-workers` does not dedupe a file reached via the
 * `worker/*` alias against the same file reached via a relative import (the
 * services' `import ... from '../schema'`): the two resolve to
 * structurally-identical but referentially distinct module instances. So
 * table identity is asserted by name via `getTableConfig(...)`, not
 * `toBe(schema.userModelConfigs)`. Same gotcha documented in
 * `test/worker/database/appService.test.ts`.
 */
function tableName(table: unknown): string {
    return getTableConfig(table as PgTable).name;
}

/**
 * Unit tests for the Postgres port of ModelConfigService and
 * ModelProvidersService (Phase 2a Task 6). Reuses the fake-drizzle recorder
 * pattern from `test/worker/database/appService.test.ts`: a fake db that
 * records every `.select()/.insert()/.update()/.delete()` call plus its
 * full chain, backed by a FIFO queue of canned row arrays - no Docker/live
 * Postgres needed.
 *
 * Also regression-pins the Phase-1 standalone-runtime branch
 * (`worker/agents/core/behaviors/base.ts:getModelConfigsInfo`, added in the
 * C1/C2 fix, commit 8f4504a): that branch short-circuits to
 * `buildDefaultModelConfigsInfo()` before ever constructing a
 * ModelConfigService when `isStandaloneRuntime(env)` is true, and was left
 * untouched by this port. The pin here proves the invariant
 * `modelConfigDefaults.ts` documents still holds after the port: for a user
 * with zero overrides, `ModelConfigService.getModelConfigsInfo`'s
 * (now-postgres) real branch produces the exact same shape as the
 * standalone default.
 */

type Row = Record<string, unknown>;

interface RecordedCall {
    entry: 'select' | 'insert' | 'update' | 'delete';
    args: unknown[];
    chainCalls: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'values', 'set', 'returning', 'groupBy'] as const;

function createFakeDb(queue: Row[][]) {
    const calls: RecordedCall[] = [];
    let cursor = 0;

    function nextRows(): Row[] {
        const rows = queue[cursor] ?? [];
        cursor += 1;
        return rows;
    }

    function makeChain(rows: Row[], record: RecordedCall) {
        const chain: Record<string, unknown> = {};
        for (const method of CHAIN_METHODS) {
            chain[method] = (...args: unknown[]) => {
                record.chainCalls.push({ method, args });
                return chain;
            };
        }
        chain.then = (onFulfilled?: (v: Row[]) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled, onRejected);
        chain.catch = (onRejected?: (e: unknown) => unknown) => Promise.resolve(rows).catch(onRejected);
        return chain;
    }

    function entryPoint(entry: RecordedCall['entry']) {
        return (...args: unknown[]) => {
            const record: RecordedCall = { entry, args, chainCalls: [] };
            calls.push(record);
            return makeChain(nextRows(), record);
        };
    }

    const db = {
        select: entryPoint('select'),
        insert: entryPoint('insert'),
        update: entryPoint('update'),
        delete: entryPoint('delete'),
    };

    return { db, calls };
}

const FAKE_ENV = {
    JWT_SECRET: 'test-jwt-secret-for-modelconfig-tests',
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

/**
 * `AGENT_CONFIG` (used by both services under test) lazily resolves through
 * `getRuntimeEnv()`, which throws until `setRuntimeEnv()` has been called
 * for the *same* module instance. `test/worker-entry.ts` already calls
 * `setRuntimeEnv()` at worker bootstrap, but via a relative import
 * (`../worker/utils/runtimeEnv`), while `worker/agents/inferutils/config.ts`
 * reads it via the `worker/*` alias (`worker/utils/runtimeEnv`) -
 * `@cloudflare/vitest-pool-workers` does not dedupe those two import paths
 * (same class of gotcha `appService.test.ts` documents for `schema.ts`, but
 * here it splits mutable module state instead of just object identity), so
 * the alias-resolved copy's `runtimeEnv` is never actually set. Bootstrapping
 * it here too - via the alias, matching `test/worker/utils/runtimeEnv.test.ts`'s
 * own precedent - fixes it for this file without touching shared test infra.
 */
setRuntimeEnv(FAKE_ENV);

/**
 * Swaps a real service instance's internal `DatabaseService` handle for the
 * fake above (constructed via the standalone-runtime env so the
 * constructor's `buildDrizzle` never dials a real Postgres connection).
 */
function attachFakeDb<T extends object>(service: T, queue: Row[][]): { service: T; calls: RecordedCall[] } {
    const { db, calls } = createFakeDb(queue);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service, calls };
}

function createModelConfigServiceWithFakeDb(queue: Row[][]) {
    return attachFakeDb(new ModelConfigService(FAKE_ENV), queue);
}

function createProvidersServiceWithFakeDb(queue: Row[][]) {
    return attachFakeDb(new ModelProvidersService(FAKE_ENV), queue);
}

function fakeUserModelConfig(overrides: Partial<Row> = {}): Row {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'cfg-1',
        userId: 'user-1',
        agentActionName: 'blueprint',
        modelName: null,
        maxTokens: null,
        temperature: null,
        reasoningEffort: null,
        providerOverride: null,
        fallbackModel: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function fakeProvider(overrides: Partial<Row> = {}): Row {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'provider-1',
        userId: 'user-1',
        name: 'My Provider',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEncrypted: 'ciphertext',
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe('ModelConfigService (postgres)', () => {
    describe('getUserModelConfigs', () => {
        it('merges the user override row into its action key and defaults the rest', async () => {
            const row = fakeUserModelConfig({
                agentActionName: 'blueprint',
                modelName: AIModels.GEMINI_2_5_PRO,
                maxTokens: 5000,
                temperature: 0.3,
                reasoningEffort: 'high',
                fallbackModel: AIModels.GEMINI_2_5_FLASH,
            });
            const { service, calls } = createModelConfigServiceWithFakeDb([[row]]);

            const result = await service.getUserModelConfigs('user-1');

            expect(result.blueprint).toMatchObject({
                name: AIModels.GEMINI_2_5_PRO,
                max_tokens: 5000,
                temperature: 0.3,
                reasoning_effort: 'high',
                fallbackModel: AIModels.GEMINI_2_5_FLASH,
                isUserOverride: true,
                userConfigId: 'cfg-1',
            });
            expect(result.templateSelection.isUserOverride).toBe(false);

            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('select');
            const fromCall = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(fromCall?.args[0])).toBe('user_model_configs');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where']);
        });
    });

    describe('getUserModelConfig', () => {
        it('reads a single agent action config via .limit(1)', async () => {
            const row = fakeUserModelConfig({ agentActionName: 'blueprint', modelName: AIModels.GEMINI_2_5_PRO });
            const { service, calls } = createModelConfigServiceWithFakeDb([[row]]);

            const result = await service.getUserModelConfig('user-1', 'blueprint');

            expect(result.isUserOverride).toBe(true);
            expect(result.name).toBe(AIModels.GEMINI_2_5_PRO);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'limit']);
            expect(calls[0].chainCalls.find((c) => c.method === 'limit')?.args[0]).toBe(1);
        });

        it('falls back to the AGENT_CONFIG default when no row exists', async () => {
            const { service } = createModelConfigServiceWithFakeDb([[]]);

            const result = await service.getUserModelConfig('user-1', 'templateSelection');

            expect(result.isUserOverride).toBe(false);
            expect(result.userConfigId).toBeUndefined();
        });
    });

    describe('getRawUserModelConfig', () => {
        it('returns null when no row exists', async () => {
            const { service } = createModelConfigServiceWithFakeDb([[]]);
            const result = await service.getRawUserModelConfig('user-1', 'blueprint');
            expect(result).toBeNull();
        });

        it('returns null when the row has no actual overrides', async () => {
            const row = fakeUserModelConfig({ agentActionName: 'blueprint' });
            const { service } = createModelConfigServiceWithFakeDb([[row]]);
            const result = await service.getRawUserModelConfig('user-1', 'blueprint');
            expect(result).toBeNull();
        });

        it('returns the merged config when the row has a real override', async () => {
            const row = fakeUserModelConfig({ agentActionName: 'blueprint', modelName: AIModels.GEMINI_2_5_PRO });
            const { service } = createModelConfigServiceWithFakeDb([[row]]);
            const result = await service.getRawUserModelConfig('user-1', 'blueprint');
            expect(result?.name).toBe(AIModels.GEMINI_2_5_PRO);
        });
    });

    describe('upsertUserModelConfig', () => {
        it('inserts a new row when none exists', async () => {
            const created = fakeUserModelConfig({ id: 'cfg-new', agentActionName: 'blueprint', modelName: AIModels.GEMINI_2_5_PRO });
            const { service, calls } = createModelConfigServiceWithFakeDb([[], [created]]);

            const result = await service.upsertUserModelConfig('user-1', 'blueprint', { name: AIModels.GEMINI_2_5_PRO });

            expect(result).toEqual(created);
            expect(calls).toHaveLength(2);
            expect(calls[0].entry).toBe('select');
            expect(calls[1].entry).toBe('insert');
            expect(tableName(calls[1].args[0])).toBe('user_model_configs');
            expect(calls[1].chainCalls.map((c) => c.method)).toEqual(['values', 'returning']);
            const valuesCall = calls[1].chainCalls.find((c) => c.method === 'values');
            expect(valuesCall?.args[0]).toMatchObject({
                userId: 'user-1',
                agentActionName: 'blueprint',
                modelName: AIModels.GEMINI_2_5_PRO,
            });
        });

        it('updates the existing row when one is found', async () => {
            const existing = fakeUserModelConfig({ id: 'cfg-1', agentActionName: 'blueprint' });
            const updated = fakeUserModelConfig({ id: 'cfg-1', agentActionName: 'blueprint', modelName: AIModels.GEMINI_2_5_PRO });
            const { service, calls } = createModelConfigServiceWithFakeDb([[existing], [updated]]);

            const result = await service.upsertUserModelConfig('user-1', 'blueprint', { name: AIModels.GEMINI_2_5_PRO });

            expect(result).toEqual(updated);
            expect(calls[1].entry).toBe('update');
            expect(calls[1].chainCalls.map((c) => c.method)).toEqual(['set', 'where', 'returning']);
        });

        it('throws on constraint violation without touching the database', async () => {
            const { service, calls } = createModelConfigServiceWithFakeDb([]);

            await expect(
                service.upsertUserModelConfig('user-1', 'templateSelection', { name: AIModels.GEMINI_2_5_PRO })
            ).rejects.toThrow();
            expect(calls).toHaveLength(0);
        });
    });

    describe('deleteUserModelConfig', () => {
        it('returns true when a row is deleted', async () => {
            const { service, calls } = createModelConfigServiceWithFakeDb([[{ id: 'cfg-1' }]]);

            const result = await service.deleteUserModelConfig('user-1', 'blueprint');

            expect(result).toBe(true);
            expect(calls[0].entry).toBe('delete');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['where', 'returning']);
        });

        it('returns false when no row matches', async () => {
            const { service } = createModelConfigServiceWithFakeDb([[]]);
            const result = await service.deleteUserModelConfig('user-1', 'blueprint');
            expect(result).toBe(false);
        });
    });

    describe('resetAllUserConfigs', () => {
        it('returns the number of deleted rows', async () => {
            const { service, calls } = createModelConfigServiceWithFakeDb([[{ id: 'a' }, { id: 'b' }]]);

            const result = await service.resetAllUserConfigs('user-1');

            expect(result).toBe(2);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['where', 'returning']);
        });

        it('returns 0 when the user has no configs', async () => {
            const { service } = createModelConfigServiceWithFakeDb([[]]);
            const result = await service.resetAllUserConfigs('user-1');
            expect(result).toBe(0);
        });
    });

    describe('getModelConfigsInfo', () => {
        it('throws without querying the database when userId is empty', async () => {
            const { service, calls } = createModelConfigServiceWithFakeDb([]);
            await expect(service.getModelConfigsInfo('')).rejects.toThrow('No user session available');
            expect(calls).toHaveLength(0);
        });

        it('returns the agents + userConfigs + defaultConfigs shape with overrides surfaced', async () => {
            const row = fakeUserModelConfig({ agentActionName: 'blueprint', modelName: AIModels.GEMINI_2_5_PRO });
            const { service } = createModelConfigServiceWithFakeDb([[row]]);

            const info = await service.getModelConfigsInfo('user-1');

            expect(info.userConfigs.blueprint).toMatchObject({ name: AIModels.GEMINI_2_5_PRO });
            expect(info.userConfigs.blueprint).not.toHaveProperty('isUserOverride');
            expect(info.userConfigs.blueprint).not.toHaveProperty('userConfigId');
            expect(Object.keys(info.defaultConfigs).length).toBe(info.agents.length);
        });

        it('matches buildDefaultModelConfigsInfo() for a user with zero overrides (standalone-branch regression pin)', async () => {
            // Regression pin for the Phase-1 standalone-runtime short-circuit
            // in worker/agents/core/behaviors/base.ts (C1/C2 fix, commit
            // 8f4504a): when isStandaloneRuntime(env) is true, base.ts never
            // constructs a ModelConfigService and returns
            // buildDefaultModelConfigsInfo() directly instead. That branch
            // was left untouched by this pg port. This test proves the two
            // paths still agree: the (now-postgres) real branch, given zero
            // user-override rows, must produce the exact shape the
            // standalone default produces - the invariant
            // modelConfigDefaults.ts's doc comment claims.
            const { service } = createModelConfigServiceWithFakeDb([[]]);

            const info = await service.getModelConfigsInfo('user-1');

            expect(info).toEqual(buildDefaultModelConfigsInfo());
        });
    });

    describe('getDefaultConfigs', () => {
        it('returns AGENT_CONFIG', () => {
            const { service } = createModelConfigServiceWithFakeDb([]);
            const defaults = service.getDefaultConfigs();
            expect(Object.keys(defaults).length).toBeGreaterThan(0);
            expect(defaults.blueprint).toBeDefined();
        });
    });
});

describe('ModelProvidersService (postgres)', () => {
    describe('providerExists', () => {
        it('returns true when a row is found via .limit(1)', async () => {
            const { service, calls } = createProvidersServiceWithFakeDb([[fakeProvider()]]);

            const result = await service.providerExists('user-1', 'My Provider');

            expect(result).toBe(true);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'limit']);
        });

        it('returns false when no row is found', async () => {
            const { service } = createProvidersServiceWithFakeDb([[]]);
            const result = await service.providerExists('user-1', 'Missing');
            expect(result).toBe(false);
        });
    });

    describe('createProvider', () => {
        it('writes the secretId DTO field to the apiKeyEncrypted column', async () => {
            const created = fakeProvider({ id: 'provider-new' });
            const { service, calls } = createProvidersServiceWithFakeDb([[created]]);

            const result = await service.createProvider('user-1', {
                name: 'My Provider',
                baseUrl: 'https://api.example.com/v1',
                secretId: 'ciphertext',
            });

            expect(result).toEqual(created);
            expect(calls[0].entry).toBe('insert');
            expect(tableName(calls[0].args[0])).toBe('user_model_providers');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['values', 'returning']);
            const valuesCall = calls[0].chainCalls.find((c) => c.method === 'values');
            expect(valuesCall?.args[0]).toMatchObject({ apiKeyEncrypted: 'ciphertext' });
            expect(valuesCall?.args[0]).not.toHaveProperty('secretId');
        });
    });

    describe('getUserProviders', () => {
        it('lists providers for the user without the D1 .all() call', async () => {
            const p1 = fakeProvider({ id: 'p1' });
            const p2 = fakeProvider({ id: 'p2' });
            const { service, calls } = createProvidersServiceWithFakeDb([[p1, p2]]);

            const result = await service.getUserProviders('user-1');

            expect(result).toEqual([p1, p2]);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where']);
        });
    });

    describe('getProvider / getProviderByName', () => {
        it('getProvider returns null when missing', async () => {
            const { service } = createProvidersServiceWithFakeDb([[]]);
            expect(await service.getProvider('user-1', 'missing')).toBeNull();
        });

        it('getProvider returns the row via .limit(1)', async () => {
            const row = fakeProvider();
            const { service, calls } = createProvidersServiceWithFakeDb([[row]]);

            expect(await service.getProvider('user-1', 'provider-1')).toEqual(row);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'limit']);
        });

        it('getProviderByName returns the row via .limit(1)', async () => {
            const row = fakeProvider();
            const { service, calls } = createProvidersServiceWithFakeDb([[row]]);

            expect(await service.getProviderByName('user-1', 'My Provider')).toEqual(row);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'limit']);
        });
    });

    describe('updateProvider', () => {
        it('maps secretId to apiKeyEncrypted when provided', async () => {
            const updated = fakeProvider({ apiKeyEncrypted: 'new-cipher' });
            const { service, calls } = createProvidersServiceWithFakeDb([[updated]]);

            const result = await service.updateProvider('user-1', 'provider-1', { secretId: 'new-cipher' });

            expect(result).toEqual(updated);
            const setCall = calls[0].chainCalls.find((c) => c.method === 'set');
            expect(setCall?.args[0]).toMatchObject({ apiKeyEncrypted: 'new-cipher' });
            expect(setCall?.args[0]).not.toHaveProperty('secretId');
        });

        it('clears apiKeyEncrypted when secretId is explicitly null', async () => {
            const updated = fakeProvider({ apiKeyEncrypted: null });
            const { service, calls } = createProvidersServiceWithFakeDb([[updated]]);

            await service.updateProvider('user-1', 'provider-1', { secretId: null });

            const setCall = calls[0].chainCalls.find((c) => c.method === 'set');
            expect(setCall?.args[0]).toMatchObject({ apiKeyEncrypted: null });
        });

        it('leaves apiKeyEncrypted untouched when secretId is omitted', async () => {
            const updated = fakeProvider({ isActive: false });
            const { service, calls } = createProvidersServiceWithFakeDb([[updated]]);

            await service.updateProvider('user-1', 'provider-1', { isActive: false });

            const setCall = calls[0].chainCalls.find((c) => c.method === 'set');
            expect(setCall?.args[0]).not.toHaveProperty('apiKeyEncrypted');
            expect(setCall?.args[0]).toMatchObject({ isActive: false });
        });

        it('returns null when no row matches', async () => {
            const { service } = createProvidersServiceWithFakeDb([[]]);
            const result = await service.updateProvider('user-1', 'missing', { isActive: false });
            expect(result).toBeNull();
        });
    });

    describe('deleteProvider', () => {
        it('returns true when a row is deleted', async () => {
            const { service, calls } = createProvidersServiceWithFakeDb([[fakeProvider()]]);

            const result = await service.deleteProvider('user-1', 'provider-1');

            expect(result).toBe(true);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['where', 'returning']);
        });

        it('returns false when no row matches', async () => {
            const { service } = createProvidersServiceWithFakeDb([[]]);
            const result = await service.deleteProvider('user-1', 'missing');
            expect(result).toBe(false);
        });
    });

    describe('toggleProviderStatus', () => {
        it('flips isActive on the fetched provider', async () => {
            const existing = fakeProvider({ isActive: true });
            const toggled = fakeProvider({ isActive: false });
            const { service, calls } = createProvidersServiceWithFakeDb([[existing], [toggled]]);

            const result = await service.toggleProviderStatus('user-1', 'provider-1');

            expect(result).toEqual(toggled);
            expect(calls[0].entry).toBe('select');
            expect(calls[1].entry).toBe('update');
            const setCall = calls[1].chainCalls.find((c) => c.method === 'set');
            expect(setCall?.args[0]).toMatchObject({ isActive: false });
        });

        it('returns null when the provider does not exist', async () => {
            const { service, calls } = createProvidersServiceWithFakeDb([[]]);
            const result = await service.toggleProviderStatus('user-1', 'missing');
            expect(result).toBeNull();
            expect(calls).toHaveLength(1);
        });
    });

    describe('getProviderCount', () => {
        it('returns the count from the first row', async () => {
            const { service } = createProvidersServiceWithFakeDb([[{ count: 3 }]]);
            const result = await service.getProviderCount('user-1');
            expect(result).toBe(3);
        });

        it('returns 0 when no rows are returned', async () => {
            const { service } = createProvidersServiceWithFakeDb([[]]);
            const result = await service.getProviderCount('user-1');
            expect(result).toBe(0);
        });
    });
});
