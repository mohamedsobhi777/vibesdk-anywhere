/**
 * Browser Supabase clients.
 *
 * `supabase` is the user-facing client: it owns the logged-in auth session
 * (persisted, auto-refreshed) and backs PostgREST calls made on the user's
 * behalf.
 *
 * `agentRealtime` is a SEPARATE client dedicated to the per-session agent
 * Realtime channel (`session:{id}`). It deliberately does NOT participate in
 * user auth (no persisted session, no auto-refresh). This matters: that
 * channel is a private, RLS-gated topic authorized by a per-session JWT whose
 * `session_id` claim satisfies the channel policy. On the shared `supabase`
 * client, `autoRefreshToken` (and any auth-state change) resets the Realtime
 * access token back to the user's login JWT — which has no `session_id` claim
 * — so the channel subscribe is rejected by RLS and `generate_all` is never
 * delivered to the agent. Isolating the channel on a client with no auth
 * lifecycle means its Realtime token is only ever the session JWT set via
 * `realtime.setAuth(...)`, and nothing clobbers it.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true } },
);

export const agentRealtime = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
            // Distinct key so this client never shares auth storage with the
            // user-facing `supabase` client above (avoids the "multiple
            // GoTrueClient instances" storage conflict).
            storageKey: 'sb-agent-realtime',
        },
    },
);
