import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const runIntegrationTests = process.env.VIBESDK_RUN_INTEGRATION_TESTS === '1';

export default defineWorkersConfig({
  resolve: {
    alias: {
      'bun:test': 'vitest',
    },
  },
  test: {
    globals: true,
    pool: '@cloudflare/vitest-pool-workers',
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@cloudflare/containers',
            '@cloudflare/sandbox',
            '@babel/traverse',
            '@babel/types',
          ],
        },
      },
    },
    poolOptions: {
      workers: {
        main: './test/worker-entry.ts',
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          compatibilityDate: '2024-12-12',
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
    include: ['**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/worker/api/routes/**',
      '**/test/worker-entry.ts',
      '**/container/monitor-cli.test.ts',
      '**/cf-git/**',
      '**/sdk/test/**', // SDK tests run with bun test, not vitest
      '**/agent-runtime/**',
      // Proves createApp() is loadable under a genuine non-workerd runtime
      // (Vercel/Node has no `cloudflare:workers`); this pool runs inside
      // workerd, where that module always resolves, which would mask
      // exactly the failure this test exists to catch. Runs via `bun test`
      // instead - see the file header comment.
      '**/test/worker/api/vercelHandler.test.ts',
      ...(runIntegrationTests ? [] : ['**/sdk/test/integration/**']),
    ],
  },
});