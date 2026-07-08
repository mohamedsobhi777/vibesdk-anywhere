/**
 * No-op postgres-js `Sql` stub for the standalone agent runtime.
 *
 * Mirrors `worker/database/noopD1.ts`: implements only the call surface
 * that `drizzle-orm/postgres-js` actually touches, then casts to the real
 * `Sql` type at the boundary instead of reimplementing porsager/postgres's
 * full (much larger) client interface.
 *
 * Reading `node_modules/drizzle-orm/postgres-js/driver.js` and
 * `session.js` gives the exact surface drizzle exercises:
 *  - `driver.js`'s `construct(client, config)` mutates
 *    `client.options.parsers`/`client.options.serializers` while wiring up
 *    type codecs, on every `drizzle(client, ...)` call — both must already
 *    be plain, mutable objects.
 *  - `session.js`'s `PostgresJsSession`/`PostgresJsPreparedQuery` call
 *    `client.unsafe(query, params)`, optionally chained with `.values()`,
 *    and `client.begin(cb)` to run transactions.
 *
 * Reads resolve to `[]`; `.begin()` invokes its callback against this same
 * no-op client with no real transaction; `.end()` resolves immediately.
 * Used only when `isStandaloneRuntime(env)` is true — see
 * `worker/database/pgConnection.ts`.
 */

import type postgres from 'postgres';

type NoopPendingQuery<T> = Promise<T[]> & {
    values: () => Promise<T[]>;
    raw: () => Promise<T[]>;
};

function emptyPendingQuery<T>(): NoopPendingQuery<T> {
    const pending = Promise.resolve<T[]>([]) as NoopPendingQuery<T>;
    pending.values = (): Promise<T[]> => Promise.resolve([]);
    pending.raw = (): Promise<T[]> => Promise.resolve([]);
    return pending;
}

interface NoopSqlHandle {
    (...args: unknown[]): NoopPendingQuery<unknown>;
    options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
    unsafe: (query: string, params?: unknown[]) => NoopPendingQuery<unknown>;
    begin: (optionsOrCallback: unknown, maybeCallback?: unknown) => Promise<unknown>;
    end: (options?: unknown) => Promise<void>;
}

export function createNoopPostgres(): postgres.Sql {
    const noopSql: NoopSqlHandle = Object.assign(
        (..._args: unknown[]): NoopPendingQuery<unknown> => emptyPendingQuery(),
        {
            options: { parsers: {}, serializers: {} },
            unsafe: (): NoopPendingQuery<unknown> => emptyPendingQuery(),
            begin: async (optionsOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
                const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as
                    (sql: postgres.Sql) => unknown;
                return await callback(noopSql as unknown as postgres.Sql);
            },
            end: async (): Promise<void> => {},
        },
    );

    return noopSql as unknown as postgres.Sql;
}
