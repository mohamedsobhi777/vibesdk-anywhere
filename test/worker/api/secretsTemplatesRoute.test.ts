import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SecretsController } from '../../../worker/api/controllers/secrets/controller';
import { getTemplatesData } from '../../../worker/types/secretsTemplates';
import { setupSecretsRoutes } from '../../../worker/api/routes/secretsRoutes';
import type { AppEnv } from '../../../worker/types/appenv';
import type { ApiResponse } from '../../../worker/api/controllers/types';
import type { SecretTemplatesData } from '../../../worker/api/controllers/secrets/types';
// Vite `?raw` import: resolved at transform time to the literal file text,
// not a module import - see the block comment below for why that matters.
// @ts-expect-error - `?raw` suffix has no type declaration in this project
import routesIndexSource from '../../../worker/api/routes/index.ts?raw';

/**
 * `GET /api/secrets/templates` (SecretsController.getTemplates) is a static,
 * zero-DB/zero-DO handler, but its route group was swept in and commented
 * out in worker/api/routes/index.ts alongside the DO-coupled user secrets
 * vault routes.
 *
 * Note on what is intentionally NOT exercised here: a full
 * `createApp(env).request('/api/secrets/templates')` round trip. Beyond the
 * auth complexity, `worker/api/routes/index.ts` (setupRoutes) transitively
 * imports every route module, including `githubExporterRoutes.ts`, whose
 * `@octokit` dependency chain hits a pre-existing `content-type` export
 * mismatch under `@cloudflare/vitest-pool-workers`'s SSR bundling -
 * independent of anything under test here (reproduced by importing
 * `setupGitHubExporterRoutes` alone; same failure family as the
 * `@sentry/cloudflare` issue documented in vitest.config.ts for
 * test/worker/api/capabilities.test.ts). That makes importing `setupRoutes`
 * itself unsafe from a vitest-collected test, so:
 *   - the handler is unit-tested directly (no route file involved), and
 *   - `setupSecretsRoutes` (worker/api/routes/secretsRoutes.ts) is
 *     exercised directly - it does not import the broken chain, and it
 *     proves the route module itself is wired correctly, and
 *   - the specific one-line re-enable in worker/api/routes/index.ts is
 *     verified against the file's literal source text (via Vite's `?raw`
 *     import, resolved at transform time so it never touches the broken
 *     runtime import graph), proving the call is present and not commented
 *     back out.
 */

describe('SecretsController.getTemplates', () => {
    it('returns the static secret template list unfiltered', async () => {
        const response = await SecretsController.getTemplates(
            new Request('https://example.com/api/secrets/templates'),
            {} as Env,
            {} as ExecutionContext,
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<SecretTemplatesData>;
        expect(json.success).toBe(true);
        expect(json.data!.templates).toEqual(getTemplatesData());
        expect(json.data!.templates.length).toBeGreaterThan(0);
    });

    it('filters by category when provided', async () => {
        const allTemplates = getTemplatesData();
        const category = allTemplates[0].category;

        const response = await SecretsController.getTemplates(
            new Request(`https://example.com/api/secrets/templates?category=${category}`),
            {} as Env,
            {} as ExecutionContext,
        );

        const json = (await response.json()) as ApiResponse<SecretTemplatesData>;
        expect(json.data!.templates.length).toBeGreaterThan(0);
        expect(json.data!.templates.every((t) => t.category === category)).toBe(true);
    });
});

describe('setupSecretsRoutes (worker/api/routes/secretsRoutes.ts)', () => {
    it('registers exactly GET /api/secrets/templates', () => {
        const app = new Hono<AppEnv>();
        setupSecretsRoutes(app);

        // Hono records one router entry per middleware/handler passed to
        // `.get(path, ...)` (the auth middleware and the controller handler
        // each get their own entry for the same method+path), so dedupe by
        // method+path rather than asserting on the raw entry count.
        const uniqueRoutes = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
        expect(uniqueRoutes).toEqual(new Set(['GET /api/secrets/templates']));
    });
});

describe('worker/api/routes/index.ts wires setupSecretsRoutes into setupRoutes', () => {
    it('imports setupSecretsRoutes from ./secretsRoutes, uncommented', () => {
        expect(routesIndexSource).toMatch(/^import \{ setupSecretsRoutes \} from '\.\/secretsRoutes';\s*$/m);
    });

    it('calls setupSecretsRoutes(app) inside setupRoutes, uncommented', () => {
        expect(routesIndexSource).toMatch(/^\s*setupSecretsRoutes\(app\);\s*$/m);
    });

    it('leaves setupUserSecretsRoutes (DO-coupled vault) commented out', () => {
        expect(routesIndexSource).toMatch(/^\s*\/\/\s*import \{ setupUserSecretsRoutes \} from '\.\/userSecretsRoutes';\s*$/m);
        expect(routesIndexSource).toMatch(/^\s*\/\/\s*setupUserSecretsRoutes\(app\);\s*$/m);
        expect(routesIndexSource).not.toMatch(/^\s*setupUserSecretsRoutes\(app\);\s*$/m);
    });
});
