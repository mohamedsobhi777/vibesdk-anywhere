import type { SupabaseLike } from './stateStore';

/** PostgREST surface for agent_conversations (superset of SupabaseLike's from()). */
export interface ConversationClient {
    from(table: string): {
        insert(rows: Record<string, unknown> | Array<Record<string, unknown>>): PromiseLike<{ error: { message: string } | null }>;
        delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
        select(columns?: string): {
            eq(column: string, value: string): {
                eq(column: string, value: string): {
                    order(column: string, opts: { ascending: boolean }): PromiseLike<{ data: Array<{ message: unknown }> | null; error: { message: string } | null }>;
                };
            };
        };
    };
}

export interface ConversationStore {
    append(kind: 'full' | 'compact', idx: number, message: unknown): Promise<void>;
    loadAll(kind: 'full' | 'compact'): Promise<unknown[]>;
    clear(): Promise<void>;
    replaceAll(kind: 'full' | 'compact', messages: unknown[]): Promise<void>;
}

export function createConversationStore(client: ConversationClient, sessionId: string): ConversationStore {
    return {
        async append(kind, idx, message) {
            const { error } = await client.from('agent_conversations').insert({
                session_id: sessionId, kind, idx, message,
            });
            if (error) throw new Error(`conversation append failed: ${error.message}`);
        },
        async loadAll(kind) {
            const { data, error } = await client
                .from('agent_conversations')
                .select('message')
                .eq('session_id', sessionId)
                .eq('kind', kind)
                .order('idx', { ascending: true });
            if (error) throw new Error(`conversation load failed: ${error.message}`);
            return (data ?? []).map((row) => row.message);
        },
        async clear() {
            const { error } = await client.from('agent_conversations').delete().eq('session_id', sessionId);
            if (error) throw new Error(`conversation clear failed: ${error.message}`);
        },
        async replaceAll(kind, messages) {
            const { error: deleteError } = await client.from('agent_conversations').delete().eq('session_id', sessionId);
            if (deleteError && deleteError.message) throw new Error(`conversation clear failed: ${deleteError.message}`);

            if (messages.length === 0) return;

            const rows = messages.map((message, idx) => ({
                session_id: sessionId,
                kind,
                idx,
                message,
            }));

            const { error: insertError } = await client.from('agent_conversations').insert(rows);
            if (insertError) throw new Error(`conversation replaceAll insert failed: ${insertError.message}`);
        },
    };
}
