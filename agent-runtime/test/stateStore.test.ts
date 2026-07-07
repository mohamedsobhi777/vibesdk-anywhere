import { describe, expect, it } from 'bun:test';
import { createStateStore } from '../src/stateStore';

function fakeSupabase() {
    const upserts: Array<Record<string, unknown>> = [];
    let stored: Record<string, unknown> | null = null;
    const client = {
        from(table: string) {
            return {
                upsert: async (row: Record<string, unknown>) => { upserts.push({ table, ...row }); stored = row; return { error: null }; },
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => ({ data: stored ? { state: (stored as { state: unknown }).state } : null, error: null }),
                    }),
                }),
            };
        },
    };
    return { client, upserts };
}

describe('createStateStore', () => {
    it('debounces bursts into one upsert and flush awaits it', async () => {
        const { client, upserts } = fakeSupabase();
        const store = createStateStore(client as never, 's-1', { debounceMs: 10 });
        store.persist({ v: 1 });
        store.persist({ v: 2 });
        store.persist({ v: 3 });
        await store.flush();
        expect(upserts).toHaveLength(1);
        expect((upserts[0].state as { v: number }).v).toBe(3);
    });

    it('load returns null when no row exists', async () => {
        const { client } = fakeSupabase();
        const store = createStateStore(client as never, 's-1');
        expect(await store.load()).toBeNull();
    });
});
