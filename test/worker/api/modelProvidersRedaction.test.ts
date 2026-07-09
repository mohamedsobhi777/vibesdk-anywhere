import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ModelProvidersController } from '../../../worker/api/controllers/modelProviders/controller';
import { ModelProvidersService } from '../../../worker/database/services/ModelProvidersService';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';
import type { RouteContext } from '../../../worker/api/types/route-context';
import type { ApiResponse } from '../../../worker/api/controllers/types';
import type { ModelProvidersListData, ModelProviderData } from '../../../worker/api/controllers/modelProviders/types';
import type { UserModelProvider } from '../../../worker/database/schema';

/**
 * Unit tests for `GET /api/user/providers` -> `ModelProvidersController.getProviders`
 * and `GET /api/user/providers/:id` -> `ModelProvidersController.getProvider`.
 *
 * Both endpoints previously returned the raw `user_model_providers` row -
 * including `apiKeyEncrypted` (the stored ciphertext) - straight to the
 * client. These tests prove the ciphertext never leaves the server and that
 * callers instead get a `hasApiKey` boolean.
 *
 * Collaborators are spied on their real class prototype (imported here via
 * the same relative-path shape the controller itself uses) rather than
 * `vi.mock`'d - see the header comment in test/worker/api/agentBootstrap.test.ts
 * for why `vi.mock` does not work reliably under `@cloudflare/vitest-pool-workers`.
 */

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

const SECRET_CIPHERTEXT = 'v1:super-secret-ciphertext-do-not-leak==';

function makeContext(userId = 'user_1'): RouteContext {
    return {
        user: { id: userId, email: 'u@e.com' },
        sessionId: null,
        config: {},
        pathParams: {},
        queryParams: new URLSearchParams(),
    } as unknown as RouteContext;
}

function fakeProvider(overrides: Partial<UserModelProvider> = {}): UserModelProvider {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'provider_1',
        userId: 'user_1',
        name: 'My Local Ollama',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEncrypted: SECRET_CIPHERTEXT,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe('GET /api/user/providers -> ModelProvidersController.getProviders', () => {
    let getUserProvidersSpy: MockInstance<ModelProvidersService['getUserProviders']>;

    beforeEach(() => {
        getUserProvidersSpy = vi.spyOn(ModelProvidersService.prototype, 'getUserProviders');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('never includes apiKeyEncrypted in the response and reports hasApiKey instead', async () => {
        getUserProvidersSpy.mockResolvedValue([fakeProvider()]);

        const response = await ModelProvidersController.getProviders(
            new Request('https://example.com/api/user/providers'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
        const rawText = await response.text();

        // The ciphertext and the field name that carries it must not appear
        // anywhere in the wire response.
        expect(rawText).not.toContain(SECRET_CIPHERTEXT);
        expect(rawText).not.toContain('apiKeyEncrypted');

        const json = JSON.parse(rawText) as ApiResponse<ModelProvidersListData>;
        expect(json.success).toBe(true);
        const providers = json.data!.providers;
        expect(providers).toHaveLength(1);
        expect(providers[0]).toMatchObject({
            id: 'provider_1',
            userId: 'user_1',
            name: 'My Local Ollama',
            baseUrl: 'https://api.example.com/v1',
            isActive: true,
            hasApiKey: true,
        });
        expect(providers[0]).not.toHaveProperty('apiKeyEncrypted');
    });

    it('reports hasApiKey as false when no key is stored', async () => {
        getUserProvidersSpy.mockResolvedValue([fakeProvider({ apiKeyEncrypted: null })]);

        const response = await ModelProvidersController.getProviders(
            new Request('https://example.com/api/user/providers'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        const json = (await response.json()) as ApiResponse<ModelProvidersListData>;
        expect(json.data!.providers[0].hasApiKey).toBe(false);
    });

    it('still filters out inactive providers', async () => {
        getUserProvidersSpy.mockResolvedValue([
            fakeProvider({ id: 'active', isActive: true }),
            fakeProvider({ id: 'inactive', isActive: false }),
        ]);

        const response = await ModelProvidersController.getProviders(
            new Request('https://example.com/api/user/providers'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        const json = (await response.json()) as ApiResponse<ModelProvidersListData>;
        expect(json.data!.providers.map((p) => p.id)).toEqual(['active']);
    });
});

describe('GET /api/user/providers/:id -> ModelProvidersController.getProvider', () => {
    let getProviderSpy: MockInstance<ModelProvidersService['getProvider']>;

    beforeEach(() => {
        getProviderSpy = vi.spyOn(ModelProvidersService.prototype, 'getProvider');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('never includes apiKeyEncrypted for a single provider fetch', async () => {
        getProviderSpy.mockResolvedValue(fakeProvider());

        const response = await ModelProvidersController.getProvider(
            new Request('https://example.com/api/user/providers/provider_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
        const rawText = await response.text();

        expect(rawText).not.toContain(SECRET_CIPHERTEXT);
        expect(rawText).not.toContain('apiKeyEncrypted');

        const json = JSON.parse(rawText) as ApiResponse<ModelProviderData>;
        expect(json.success).toBe(true);
        expect(json.data!.provider).toMatchObject({
            id: 'provider_1',
            hasApiKey: true,
        });
        expect(json.data!.provider).not.toHaveProperty('apiKeyEncrypted');

        expect(getProviderSpy).toHaveBeenCalledWith('user_1', 'provider_1');
    });

    it('returns an error response (never leaking ciphertext) when the provider does not exist', async () => {
        getProviderSpy.mockResolvedValue(null);

        const response = await ModelProvidersController.getProvider(
            new Request('https://example.com/api/user/providers/missing'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(500);
        const json = (await response.json()) as ApiResponse<ModelProviderData>;
        expect(json.success).toBe(false);
        expect(json.data).toBeUndefined();
    });
});
