-- supabase/migrations/20260707000001_agent_runtime.sql
create table if not exists agent_sessions (
    session_id text primary key,
    agent_id text not null,
    user_id uuid,
    status text not null default 'provisioning',
    init_args jsonb,
    sandbox_id text,
    last_activity_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create table if not exists agent_state (
    session_id text primary key references agent_sessions(session_id) on delete cascade,
    state jsonb not null,
    updated_at timestamptz not null default now()
);

create table if not exists agent_messages (
    id bigint generated always as identity primary key,
    session_id text not null references agent_sessions(session_id) on delete cascade,
    seq bigint not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    unique (session_id, seq)
);

create table if not exists agent_conversations (
    session_id text not null references agent_sessions(session_id) on delete cascade,
    kind text not null check (kind in ('full', 'compact')),
    idx bigint not null,
    message jsonb not null,
    primary key (session_id, kind, idx)
);

alter table agent_sessions enable row level security;
alter table agent_state enable row level security;
alter table agent_messages enable row level security;
alter table agent_conversations enable row level security;

-- Session-scoped JWTs carry a `session_id` claim; a token grants full access
-- to exactly its own session's rows (agent process and browser use the same
-- shape; the Vercel API uses the service role and bypasses RLS).
create policy session_rw_sessions on agent_sessions
    for all using (session_id = (auth.jwt() ->> 'session_id'))
    with check (session_id = (auth.jwt() ->> 'session_id'));
create policy session_rw_state on agent_state
    for all using (session_id = (auth.jwt() ->> 'session_id'))
    with check (session_id = (auth.jwt() ->> 'session_id'));
create policy session_rw_messages on agent_messages
    for all using (session_id = (auth.jwt() ->> 'session_id'))
    with check (session_id = (auth.jwt() ->> 'session_id'));
create policy session_rw_conversations on agent_conversations
    for all using (session_id = (auth.jwt() ->> 'session_id'))
    with check (session_id = (auth.jwt() ->> 'session_id'));

-- Realtime private-channel authorization: allow joining broadcast topic
-- `session:{session_id}` for holders of the matching claim.
create policy session_realtime_read on realtime.messages
    for select using (
        realtime.topic() = 'session:' || (auth.jwt() ->> 'session_id')
    );
create policy session_realtime_write on realtime.messages
    for insert with check (
        realtime.topic() = 'session:' || (auth.jwt() ->> 'session_id')
    );
