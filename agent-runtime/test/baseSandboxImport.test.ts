import { describe, expect, it } from 'bun:test';
import { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';

/**
 * Regression guard: BaseSandboxService.ts previously had a top-level
 * `import { env } from 'cloudflare:workers'` used only by its two static
 * template methods. That import is unresolvable under Bun and blocked the
 * whole class from loading, which in turn blocked importing anything that
 * transitively pulls in this module from the standalone agent runtime.
 * Byte-fetching now goes through the templateSource seam (default: R2 via
 * getRuntimeEnv(), read lazily inside methods) so this class stays
 * importable under Bun with no Workers bindings present.
 */
describe('BaseSandboxService importability under Bun', () => {
    it('imports without module-resolution errors and exposes the class', () => {
        expect(typeof BaseSandboxService).toBe('function');
    });
});
