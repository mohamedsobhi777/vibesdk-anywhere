export interface SupabaseLike {
    from(table: string): {
        upsert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
        select(columns?: string): {
            eq(column: string, value: string): {
                maybeSingle(): PromiseLike<{ data: { state: unknown } | null; error: { message: string } | null }>;
            };
        };
    };
}

export interface StateStore {
    load(): Promise<Record<string, unknown> | null>;
    persist(state: unknown): void;
    flush(): Promise<void>;
}

export function createStateStore(
    client: SupabaseLike,
    sessionId: string,
    opts: { debounceMs?: number } = {},
): StateStore {
    const debounceMs = opts.debounceMs ?? 300;
    let pending: unknown;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: Promise<void> = Promise.resolve();

    const write = () => {
        const state = pending;
        timer = null;
        inflight = inflight.then(async () => {
            const { error } = await client.from('agent_state').upsert({
                session_id: sessionId,
                state,
                updated_at: new Date().toISOString(),
            });
            if (error) {
                console.error(`agent_state persist failed: ${error.message}`);
            }
        });
    };

    return {
        async load() {
            const { data, error } = await client
                .from('agent_state')
                .select('state')
                .eq('session_id', sessionId)
                .maybeSingle();
            if (error) throw new Error(`agent_state load failed: ${error.message}`);
            return (data?.state as Record<string, unknown>) ?? null;
        },
        persist(state: unknown) {
            pending = state;
            if (timer) clearTimeout(timer);
            timer = setTimeout(write, debounceMs);
        },
        async flush() {
            if (timer) { clearTimeout(timer); write(); }
            await inflight;
        },
    };
}
