import { describe, expect, it } from 'bun:test';
import { buildEnvAdapter } from '../src/envAdapter';

describe('buildEnvAdapter', () => {
    it('exposes string vars from the source', () => {
        const env = buildEnvAdapter({ CLOUDFLARE_AI_GATEWAY_URL: 'https://gw.example', TEMPLATES_REPOSITORY: 'x' });
        expect(env.CLOUDFLARE_AI_GATEWAY_URL).toBe('https://gw.example');
    });

    it('throws a named error when a Workers binding is touched', () => {
        const env = buildEnvAdapter({});
        expect(() => (env.AI as { gateway(id: string): unknown }).gateway('x')).toThrow(/Unsupported binding "AI"/);
        expect(() => (env.TEMPLATES_BUCKET as { get(k: string): unknown }).get('k')).toThrow(/TEMPLATES_BUCKET/);
    });
});
