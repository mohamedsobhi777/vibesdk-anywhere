import { describe, expect, it } from 'vitest';
import { buildDrizzle } from 'worker/database/pgConnection';
import * as schema from 'worker/database/schema';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

describe('buildDrizzle', () => {
    it('resolves queries to an empty result with no real connection on the standalone runtime', async () => {
        const standaloneEnv = { [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE } as unknown as Env;

        const db = buildDrizzle(standaloneEnv);
        const rows = await db.select().from(schema.systemSettings).limit(1);

        expect(rows).toEqual([]);
    });
});
