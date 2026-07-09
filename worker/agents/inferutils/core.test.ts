import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getConfigurationForModel } from './core';
import {
	credentialsToRuntimeOverrides,
	type AIModelConfig,
	ModelSize,
} from './config.types';

const PLATFORM_KEY = 'sk-platform-secret-key-1234567890';
const USER_KEY = 'sk-user-byok-key-1234567890';
const ATTACKER_URL = 'https://attacker.example/v1';
const PLATFORM_GATEWAY = 'https://gateway.example/v1';

// A non-directOverride model (gateway-routed path) for the openai provider.
const MODEL_CONFIG: AIModelConfig = {
	name: 'gpt-test',
	size: ModelSize.REGULAR,
	provider: 'openai',
	creditCost: 1,
	contextSize: 128_000,
};

// Build a deterministic env: a valid platform provider key and a fixed
// platform gateway URL so buildGatewayUrl never depends on the AI binding.
function makeEnv(overrides: Record<string, unknown> = {}): Env {
	return {
		...env,
		OPENAI_API_KEY: PLATFORM_KEY,
		CLOUDFLARE_AI_GATEWAY_URL: PLATFORM_GATEWAY,
		...overrides,
	} as unknown as Env;
}

describe('getConfigurationForModel - gateway/key coupling', () => {
	it('does NOT pair the platform env key with an attacker-supplied baseUrl', async () => {
		const runtimeOverrides = credentialsToRuntimeOverrides({
			aiGateway: { baseUrl: ATTACKER_URL, token: 'anything' },
		});

		const { apiKey } = await getConfigurationForModel(
			MODEL_CONFIG,
			makeEnv(),
			'user-1',
			runtimeOverrides,
		);

		// Core invariant: when a custom gateway baseUrl is present, the platform
		// env key is structurally unreachable. Only the caller's own override
		// token may be sent to the override URL.
		expect(apiKey).not.toBe(PLATFORM_KEY);
		expect(apiKey).toBe('anything');
	});

	it('never returns the platform env key when a baseUrl override has an empty token', async () => {
		const runtimeOverrides = credentialsToRuntimeOverrides({
			aiGateway: { baseUrl: ATTACKER_URL, token: '' },
		});

		const { apiKey } = await getConfigurationForModel(
			MODEL_CONFIG,
			makeEnv(),
			'user-1',
			runtimeOverrides,
		);

		// Even with an empty override token, the platform key must not leak.
		expect(apiKey).not.toBe(PLATFORM_KEY);
		expect(apiKey).toBe('');
	});

	it('honors the custom gateway baseUrl when a user provider key is supplied', async () => {
		const runtimeOverrides = credentialsToRuntimeOverrides({
			providers: { openai: { apiKey: USER_KEY } },
			aiGateway: { baseUrl: ATTACKER_URL, token: 'user-token' },
		});

		const { apiKey, baseURL } = await getConfigurationForModel(
			MODEL_CONFIG,
			makeEnv(),
			'user-1',
			runtimeOverrides,
		);

		expect(apiKey).toBe(USER_KEY);
		expect(baseURL.startsWith(ATTACKER_URL)).toBe(true);
	});

	it('uses the platform key and gateway when no override is supplied', async () => {
		const { apiKey, baseURL } = await getConfigurationForModel(
			MODEL_CONFIG,
			makeEnv(),
			'user-1',
		);

		expect(apiKey).toBe(PLATFORM_KEY);
		expect(baseURL.startsWith(PLATFORM_GATEWAY)).toBe(true);
	});
});

describe('getConfigurationForModel - direct provider routing (no gateway)', () => {
	const GEMINI_MODEL_CONFIG: AIModelConfig = {
		name: 'gemini-test',
		size: ModelSize.REGULAR,
		provider: 'google-ai-studio',
		creditCost: 1,
		contextSize: 1_000_000,
	};

	// Standalone stack: no Workers `AI` binding and no gateway URL, so the
	// binding path in buildGatewayUrl would throw and direct routing must win.
	function standaloneEnv(overrides: Record<string, unknown> = {}): Env {
		return {
			...env,
			AI: undefined,
			CLOUDFLARE_AI_GATEWAY_URL: undefined,
			GOOGLE_AI_STUDIO_API_KEY: PLATFORM_KEY,
			...overrides,
		} as unknown as Env;
	}

	it('routes google-ai-studio directly to the Google endpoint with the platform key', async () => {
		const { apiKey, baseURL, isDirect } = await getConfigurationForModel(
			GEMINI_MODEL_CONFIG,
			standaloneEnv(),
			'user-1',
		);

		expect(isDirect).toBe(true);
		expect(baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
		expect(apiKey).toBe(PLATFORM_KEY);
	});

	it('throws for a provider with no direct endpoint when no gateway is configured', async () => {
		const vertexConfig: AIModelConfig = { ...GEMINI_MODEL_CONFIG, provider: 'google-vertex-ai' };
		await expect(
			getConfigurationForModel(vertexConfig, standaloneEnv(), 'user-1'),
		).rejects.toThrow(/no direct endpoint/);
	});

	it('still routes through the gateway when CLOUDFLARE_AI_GATEWAY_URL is configured', async () => {
		const { baseURL, isDirect } = await getConfigurationForModel(
			GEMINI_MODEL_CONFIG,
			standaloneEnv({ CLOUDFLARE_AI_GATEWAY_URL: PLATFORM_GATEWAY }),
			'user-1',
		);

		expect(isDirect).toBeUndefined();
		expect(baseURL.startsWith(PLATFORM_GATEWAY)).toBe(true);
	});

	it('honors an explicit directOverride even when a gateway is available', async () => {
		const directModel: AIModelConfig = { ...GEMINI_MODEL_CONFIG, directOverride: true };
		const { baseURL, isDirect } = await getConfigurationForModel(
			directModel,
			standaloneEnv({ CLOUDFLARE_AI_GATEWAY_URL: PLATFORM_GATEWAY }),
			'user-1',
		);

		expect(isDirect).toBe(true);
		expect(baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
	});
});

describe('credentialsToRuntimeOverrides - baseUrl validation', () => {
	it('drops a non-https gateway baseUrl', () => {
		const result = credentialsToRuntimeOverrides({
			aiGateway: { baseUrl: 'http://attacker.example/v1', token: 't' },
		});
		expect(result?.aiGatewayOverride).toBeUndefined();
	});

	it('drops a malformed gateway baseUrl', () => {
		const result = credentialsToRuntimeOverrides({
			aiGateway: { baseUrl: 'not-a-url', token: 't' },
		});
		expect(result?.aiGatewayOverride).toBeUndefined();
	});

	it('keeps a valid https gateway baseUrl', () => {
		const result = credentialsToRuntimeOverrides({
			aiGateway: { baseUrl: ATTACKER_URL, token: 't' },
		});
		expect(result?.aiGatewayOverride?.baseUrl).toBe(ATTACKER_URL);
	});
});
