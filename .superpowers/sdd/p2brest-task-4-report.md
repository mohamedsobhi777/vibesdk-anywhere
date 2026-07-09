# P2b REST Task 4 — Favorites + Stars: Postgres tables + migration + AppService methods

## Summary

`favorites`/`stars` were dropped in the lean 7-table Postgres schema rewrite
(`3943487`), which left `AppService.getFavoriteAppsOnly`, `toggleAppFavorite`,
`toggleAppStar`, and the `sort=starred` branches throwing
`DeferredInPhase2aError`, and `isFavorite`/`starCount` hardcoded false/0 in the
listing queries. This task re-adds both tables (schema.ts + a new migration)
and implements the deferred methods against them.

## Table shapes + PK choice

Both tables use the same shape, mirroring the pre-rewrite D1 schema's columns
minus the surrogate id:

```ts
export const favorites = pgTable('favorites', {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ columns: [table.userId, table.appId] }),
    index('favorites_user_idx').on(table.userId),
    index('favorites_app_idx').on(table.appId),
]);
// `stars` is identical in shape.
```

**PK choice: composite `primaryKey({ columns: [userId, appId] })`**, not a
surrogate `id` + `UNIQUE(user_id, app_id)`. Both tables are pure
user/app join tables with no independent identity — a composite PK gives
"one favorite/star per user per app" for free and needs no extra unique
index. Two btree indexes cover both query directions:
`favorites_user_idx`/`stars_user_idx` (leading column of the PK itself,
covers "this user's favorites/stars") and an explicit
`favorites_app_idx`/`stars_app_idx` (PK's second column isn't a usable
leftmost prefix on its own) for "who favorited/starred this app" and the new
per-app `starCount` scalar subquery.

Deviation from the pre-rewrite D1 schema: dropped the surrogate `id` column
(unnecessary with a composite PK) and renamed `stars.starredAt` to
`createdAt` (consistent with every other table in the lean schema).

## Migration

`supabase/migrations/20260709000001_favorites_stars.sql` — additive only,
doesn't touch `20260707000001_agent_runtime.sql` or `20260708000001_core.sql`.
Mirrors `20260708000001_core.sql`'s exact style: `create table public.X`,
indexes, `enable row level security`, then
`create policy user_rw_X for all using (user_id = auth.uid()) with check
(user_id = auth.uid())`. The API writes through the service-role connection
(bypasses RLS via `BYPASSRLS`); the policies are for direct client-side
Supabase access, consistent with the rest of the schema.

Not run against a local Supabase instance (`test/worker/database/
coreMigration.test.ts`'s pattern, gated behind `SUPABASE_LOCAL=1`, requires
`bunx supabase start` + Docker, unavailable in this environment) — verified
by careful column-for-column comparison against `schema.ts` instead. No new
test added to `coreMigration.test.ts` for this migration specifically (would
need the same Docker-gated setup as the existing file); flagged as a
follow-up if CI has Supabase-local available.

## AppService methods

### toggleAppFavorite(userId, appId): Promise<FavoriteToggleResult>

`FavoriteToggleResult` is `{ isFavorite: boolean }` (checked
`worker/database/types.ts` — no count field, so no transaction needed).
Select-then-act: if a `favorites` row exists for `(userId, appId)`, delete it
and return `{ isFavorite: false }`; otherwise insert it and return
`{ isFavorite: true }`. The insert uses `.onConflictDoNothing()` (PK conflict
on a concurrent double-favorite race resolves to a no-op instead of an
uncaught unique-violation error) — added `onConflictDoNothing` to the fake-db
recorder's `CHAIN_METHODS` in `appService.test.ts` to support asserting it.

### toggleAppStar(userId, appId): Promise<{ isStarred: boolean; starCount: number }>

Same select-then-act toggle on `stars`, then a fresh `COUNT(*) FROM stars
WHERE app_id = ?` to return the real post-toggle count. Three DB round-trips
(exists check, insert-or-delete, count) — deliberately not folded into fewer
queries since `RETURNING`-based count tricks would complicate the
insert/delete branching for no real benefit at this table size.

### getFavoriteAppsOnly(userId, options = {}): Promise<AppWithFavoriteStatus[]>

Controller (`worker/api/controllers/apps/controller.ts:65`) calls this with
just `userId` — kept that call site working by defaulting `options`. Inner
join `favorites` → `apps`, ordered by `favorites.createdAt desc`
(most-recently-favorited first — a deliberate choice over `apps.updatedAt`,
since this is a "my favorites" list, not an app-activity list), same
`AppWithFavoriteStatus[]` shape as `getUserAppsWithFavorites`
(`isFavorite: true` on every row, since every row here came from a favorites
join).

## Re-enabled in the ranked/list queries

- **`getUserAppsWithFavorites`**: real `isFavorite` via a new
  `getUserFavoriteAppIds(userId, appIds)` helper (`favorites` filtered by
  `user_id` + `app_id IN (...)`), replacing the `isFavorite: false` stub.
- **`sort=starred`** (`getUserAppsWithAnalytics`, `getUserAppsCount`, and by
  extension `getPublicApps`/public listings since they share
  `executeRankedQuery`): the early `DeferredInPhase2aError` throws are gone;
  `executeRankedQuery` gained a dedicated `starred` branch that orders by a
  real star-count subquery (tie-broken by recency). `getUserAppsCount`'s
  count query doesn't care about sort order at all, so removing its throw
  needed nothing else (dropped the now-unused `sort` destructure).
- **`starCount`** in every `executeRankedQuery` branch (trending/popular,
  starred, recent) and in `getCountSubqueries()`: real correlated scalar
  subquery `getStarCountSubquery()` — `(SELECT COUNT(*) FROM stars WHERE
  app_id = apps.id)` — same pattern as the pre-existing `forkCount`
  subquery, not hardcoded `sql`0`` anymore.
- **`userStarred`/`userFavorited`** in `getPublicApps` and
  `getUserAppsWithAnalytics`: `addUserSpecificAppData` now does two real
  queries (`getUserStarredAppIds`, `getUserFavoriteAppIds`, run in parallel
  via `Promise.all`) instead of always returning empty sets.

`viewCount` stays hardcoded `0` everywhere — `app_views` is still deferred,
out of this task's scope.

## Explicitly left as follow-ups (not touched)

Step C's heading frames its scope as "remove the `DeferredInPhase2aError`
throws" plus the two explicitly-named re-enables (`isFavorite` in
`getUserAppsWithFavorites`, `starCount` in the ranked queries). Two other
methods have their own separate `isFavorite`/`starCount` hardcodes but were
**not** named in Step C and don't throw (`DeferredInPhase2aError`'s own doc
comment: "Mutations that have no meaningful safe default throw this instead
of silently no-op'ing" — these are deliberate soft-degrades, not throws), so
left alone to keep this diff scoped to what was asked:

- **`getSingleAppWithFavoriteStatus`** (`AppService.ts:418`): still returns
  `isFavorite: false` unconditionally. Fix is mechanical (one call to the new
  `getUserFavoriteAppIds(userId, [appId])` helper) — updated its doc
  comment/debug log to say "follow-up" instead of the now-inaccurate
  "favorites table not yet ported."
- **`getAppDetails`** (`AppService.ts:507`): still returns `starCount: 0,
  userStarred: false, userFavorited: false` unconditionally (`viewCount: 0`
  stays correct — appViews genuinely still deferred). This is the app-detail
  page's primary read path; wiring it up is a similarly small, mechanical
  follow-up using `getStarCountSubquery`/`getUserStarredAppIds`/
  `getUserFavoriteAppIds`, deferred here only to keep this diff matching the
  task's literal Step C scope. Updated its doc comment for accuracy.

Also updated (comment-only, no behavior change) every other doc comment in
`AppService.ts` that asserted "favorites/stars table not yet ported" — that
claim became false the moment the migration landed, and stale docs are worse
than no docs (`deleteApp`'s comment now correctly attributes the missing
cascade-cleanup code to the FKs' `ON DELETE CASCADE`, not to the tables not
existing).

## Tests (RED -> GREEN, verified by literal stash)

Verified genuine RED by `git stash push` on the three source files (`schema.ts`,
`database.ts`, `AppService.ts`) while keeping the test edits, running the
suite (16 failures — exactly the new/changed-behavior tests, 21 pre-existing
tests still passed), then `git stash pop` to restore the implementation and
re-confirm all green.

- `test/worker/database/schema.test.ts`: added `describe('favorites')` +
  `describe('stars')` — column types/nullability, the composite
  `primaryKeys` entry (`getTableConfig(...).primaryKeys[0].columns`), and the
  two named indexes each. 13 -> 19 tests.
- `test/worker/database/appService.test.ts`:
  - `getUserAppsWithFavorites`: rewrote the first case for real `isFavorite`
    (2 queries now, previously locked in at 1 with `isFavorite: false`
    stubbed) — the "no apps -> 1 query, no favorites lookup" early-return
    case is untouched and still passes.
  - New `toggleAppFavorite`/`toggleAppStar`/`getFavoriteAppsOnly` describe
    blocks (7 tests) asserting table names via the recorder's `.from`/entry
    `args[0]`, chain method order (`values` -> `onConflictDoNothing`), and
    return shapes for both toggle directions plus the empty-count edge case.
  - Replaced the old "deferred-in-2a stubs" block's
    `toggleAppFavorite`/`toggleAppStar`/`getFavoriteAppsOnly`-throw
    assertions (now factually wrong) and the `sort=starred`-throws
    assertions with real-resolution assertions; kept `recordAppView`'s
    no-op test verbatim (appViews still deferred). Removed the now-unused
    `DeferredInPhase2aError` import.
  - 14 -> 18 tests.

## Gate results

- `bun run test -- test/worker/database/schema.test.ts
  test/worker/database/appService.test.ts` — 37/37 pass.
- `bun run typecheck` (`tsc -b --incremental --noEmit`) — exit 0.
- `bunx tsc -b --force --noEmit` — exit 0.
- `bun test agent-runtime` — 69 pass, 3 skip, 0 fail (matches baseline).
- Full suite (`bun run test`): first two attempts hit the documented
  `workerd`/`EADDRNOTAVAIL` intermittent infra flake (port exhaustion from
  parallel workerd instances) after ~34 files, zero `FAIL`s in the completed
  portion. Re-ran with `bunx vitest run --no-file-parallelism` (serial, to
  avoid the port exhaustion) and got a clean full run: **452 passed, 3
  skipped, 0 failed, exit 0** — exactly baseline 442 + the 10 net-new tests
  added here (schema.test.ts +6, appService.test.ts +4), zero regressions.
- `bunx eslint` on all 3 changed source files — 0 problems.

## Commit

`843ca7b` — `feat: favorites + stars postgres tables and app service`
(files: `worker/database/schema.ts`, `worker/database/database.ts`,
`worker/database/services/AppService.ts`,
`test/worker/database/schema.test.ts`, `test/worker/database/appService.test.ts`,
`supabase/migrations/20260709000001_favorites_stars.sql`, this report).

## Concerns / things worth a second look

1. **Migration untested against real Postgres** (no Docker/Supabase-local in
   this environment) — the SQL was hand-verified column-for-column against
   `schema.ts` and against `20260708000001_core.sql`'s exact style, but has
   not actually been run through `supabase db reset` + the `coreMigration.
   test.ts`-style live assertions. Worth a real run before this ships.
2. **`getAppDetails`/`getSingleAppWithFavoriteStatus`** still return
   stale/stubbed favorite+star data on two real, currently-linked read paths
   (app detail page, single-app-with-favorite-status). Functionally
   unchanged from before this task (still returns `false`/`0`, never
   throws), but now slightly inconsistent with sibling methods that got the
   real implementation. Flagged above as the two concrete follow-ups.
3. **`toggleAppFavorite`/`toggleAppStar` are 2-3 sequential round-trips**
   (select existence, then insert-or-delete, then — for stars — a count
   query) rather than a single `RETURNING`-based statement. Simpler and
   matches this file's existing style (`updateAppVisibility`, `deleteApp`
   also do multi-step select-then-act), but under high concurrency on the
   same `(user, app)` pair there's a narrow window between the exists-check
   and the write; `onConflictDoNothing()` prevents that from throwing, so
   the worst case is a slightly stale toggle result on the losing request of
   a true race — not a correctness bug, just worth knowing about.
