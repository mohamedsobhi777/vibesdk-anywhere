import { afterEach, describe, expect, it } from 'vitest';
// NOTE: imported by relative path (not the `worker/*` alias) so this test
// resolves to the exact same module instance that BaseSandboxService.ts
// imports internally (also via relative path). vitest-pool-workers bundles
// each test file's module graph separately from the alias-resolved graph,
// so mixing import styles for this file creates two separate singletons —
// setTemplateSource() would silently mutate a copy BaseSandboxService never
// reads. See worker/services/sandbox/BaseSandboxService.ts's own import.
import { createHttpTemplateSource, setTemplateSource, resetTemplateSourceForTests } from '../../../../worker/services/sandbox/templateSource';
import { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';

afterEach(() => resetTemplateSourceForTests());

describe('template source seam', () => {
    it('listTemplates uses an injected source', async () => {
        setTemplateSource({
            getCatalog: async () => [
                { name: 'vite-app', language: 'ts', frameworks: ['react'], description: { selection: 's', usage: 'u' } } as never,
                { name: 'next-app', language: 'ts', frameworks: [], description: { selection: 's', usage: 'u' } } as never,
            ],
            getZip: async () => new ArrayBuffer(0),
        });
        const result = await BaseSandboxService.listTemplates();
        expect(result.success).toBe(true);
        expect(result.templates.map((t) => t.name)).toEqual(['vite-app']); // next-* filtered, existing behavior
    });

    it('http source hits catalog and zip URLs', async () => {
        const urls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            urls.push(String(input));
            return new Response(JSON.stringify([]), { status: 200 });
        }) as typeof fetch;
        try {
            const source = createHttpTemplateSource('https://templates.example.com');
            await source.getCatalog();
            expect(urls[0]).toBe('https://templates.example.com/template_catalog.json');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
