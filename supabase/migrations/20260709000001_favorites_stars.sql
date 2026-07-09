-- supabase/migrations/20260709000001_favorites_stars.sql
--
-- Favorites (private per-user bookmarks) and stars (public per-app
-- popularity signal, like GitHub stars) - both dropped in the lean
-- 7-table rewrite (20260708000001_core.sql) and re-added here so
-- AppService.toggleAppFavorite/toggleAppStar/getFavoriteAppsOnly and the
-- `sort=starred`/starCount branches have a Postgres table to read and
-- write. Mirrors worker/database/schema.ts's `favorites`/`stars`
-- pgTables column-for-column. Additive only: does not touch
-- 20260707000001_agent_runtime.sql or 20260708000001_core.sql.
--
-- The API writes through the service-role Postgres connection, which
-- bypasses RLS (BYPASSRLS) - the policies below are for direct
-- client-side Supabase access, consistent with the rest of this schema.

create table public.favorites (
    user_id uuid not null references public.users(id) on delete cascade,
    app_id text not null references public.apps(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, app_id)
);

create index favorites_user_idx on public.favorites (user_id);
create index favorites_app_idx on public.favorites (app_id);

create table public.stars (
    user_id uuid not null references public.users(id) on delete cascade,
    app_id text not null references public.apps(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, app_id)
);

create index stars_user_idx on public.stars (user_id);
create index stars_app_idx on public.stars (app_id);

alter table public.favorites enable row level security;
alter table public.stars enable row level security;

-- Users manage their own favorites/stars only.
create policy user_rw_favorites on public.favorites
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());

create policy user_rw_stars on public.stars
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());
