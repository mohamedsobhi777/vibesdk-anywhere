import { describe, expect, it } from 'bun:test';
import { createClient } from '@supabase/supabase-js';

const gate = process.env.SUPABASE_LOCAL === '1' ? describe : describe.skip;

// Requires: `bunx supabase start` + `bunx supabase db reset` beforehand.
// Local defaults from `supabase status`:
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

gate('agent runtime schema', () => {
    it('service role can insert a session and its state', async () => {
        const admin = createClient(url, serviceKey);
        const sessionId = `s-${crypto.randomUUID()}`;
        const s = await admin.from('agent_sessions').insert({ session_id: sessionId, agent_id: 'a-1', init_args: { query: 'test' } });
        expect(s.error).toBeNull();
        const st = await admin.from('agent_state').insert({ session_id: sessionId, state: { hello: 1 } });
        expect(st.error).toBeNull();
        await admin.from('agent_sessions').delete().eq('session_id', sessionId);
    });

    it('anon client without the session claim cannot read agent_state', async () => {
        const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
        const anon = createClient(url, anonKey);
        const r = await anon.from('agent_state').select('*').limit(1);
        expect(r.data ?? []).toHaveLength(0);
    });
});
