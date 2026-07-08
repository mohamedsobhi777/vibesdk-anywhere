# Phase 2a: Data + Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace vibesdk's Cloudflare D1/DO data layer and hand-rolled auth with Supabase Postgres (Drizzle over postgres-js) + Supabase Auth, greenfield (no data migration), coexisting with the Phase-1 agent_* tables.

**Architecture:** Swap the Drizzle driver from `drizzle-orm/d1` to `drizzle-orm/postgres-js` behind the existing `DatabaseService`, preserving the Phase-1 standalone `isStandaloneRuntime → no-op DB` seam (now a no-op postgres). Rewrite `worker/database/schema.ts` as a lean pg-core schema (~7 core tables; Supabase Auth subsumes ~8 auth tables). Add a fresh Supabase migration with `auth.uid()` RLS. Port `UserSecretsStore` (crypto unchanged) and the rate limiter to Postgres tables. Replace `JWTUtils`/`SessionService`/OAuth with a thin Supabase Auth adapter.

**Tech Stack:** Supabase Postgres, `postgres` (postgres-js), `drizzle-orm/postgres-js`, `drizzle-kit` (postgresql), `@supabase/supabase-js` (already present), bun, vitest-pool-workers (worker unit tests) + `SUPABASE_LOCAL=1`-gated live-Postgres integration tests.

## Global Constraints
- **Greenfield / big-bang:** zero users, NO data migration, NO dual-run, NO feature flags. Cloudflare is being abandoned — the Workers app need not fully RUN mid-2a, but every task must leave the tree TYPECHECKING (`bun run typecheck` + `bun run typecheck:agent-runtime` green) and the agent-runtime tests green. Any task that leaves the Workers *runtime* temporarily non-functional must say so and why it's acceptable (2b removes the Workers entry entirely).
- **Supabase Auth is the identity source.** `auth.users` owns identity; `public.users` is a profile extension keyed `id uuid references auth.users(id)`. No hand-rolled JWT/session/password/OAuth-state tables.
- **Phase-1 coexistence (do NOT break):** the standalone agent runtime must keep getting a no-op DB via `isStandaloneRuntime(env)` (it never touches real Postgres). The Phase-1 `supabase/migrations/20260707000001_agent_runtime.sql` tables + their `session_id`-claim RLS are UNTOUCHED. User-facing RLS uses `auth.uid()`; agent RLS keeps the session-JWT claim — both valid concurrently.
- No `any`. No emojis. Drizzle pg-core idioms. Real timestamps as `timestamp with time zone`; booleans `boolean`; json `jsonb`.
- Connection string from `env.SUPABASE_DB_URL` (Supabase pooler, `postgres://…:6543/postgres?sslmode=require`); Supabase URL/anon/service keys from existing `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` vars.
- Commit after every task; conventional commits; no co-author lines.

## File Structure
| Path | Action | Responsibility |
|---|---|---|
| `package.json` | modify | add `postgres`; drizzle-kit stays |
| `drizzle.config.local.ts` / `drizzle.config.remote.ts` | modify | dialect `postgresql`, url from env |
| `worker/database/pgConnection.ts` | create | `getPostgresClient()` singleton + `buildDrizzle(env)` with the standalone no-op seam |
| `worker/database/noopPg.ts` | create | no-op postgres-js-shaped driver for standalone (replaces noopD1 usage in DatabaseService) |
| `worker/database/database.ts` | modify | drizzle-orm/pg; drop `withSession`/`getReadDb` D1 replica logic; use pgConnection + no-op seam |
| `worker/database/schema.ts` | rewrite | lean pg-core schema (7 core tables); drop auth-subsumed tables |
| `supabase/migrations/20260708000001_core.sql` | create | core tables + RLS (auth.uid()); coexist with agent_* |
| `worker/services/auth/supabaseAuth.ts` | create | Supabase Auth adapter: verify token → user; upsert profile; middleware |
| `worker/database/services/*.ts` | modify | AppService/UserService/ModelConfigService/ModelProvidersService pg port; delete AuthService/SessionService/ApiKeyService |
| `worker/services/secrets/secretsStore.ts` | create | Postgres-backed vault store (crypto reused from existing secrets module) |
| `worker/services/rate-limit/pgRateLimitStore.ts` | create | `rate_limit_buckets` window algorithm |
| `worker/services/config/systemSettingsStore.ts` | create | system_settings read/write (retires KV CONFIG_KEY) |
| `test/worker/database/*.test.ts`, `test/worker/services/*.test.ts` | create | unit tests; live-pg gated on SUPABASE_LOCAL=1 |
| `docs/phase2a-notes.md` | create | what changed, retired tables, deferred items, live-verify commands |

---

### Task 1: Postgres connection module + standalone no-op seam + Drizzle config

**Files:** create `worker/database/pgConnection.ts`, `worker/database/noopPg.ts`; modify `package.json`, `drizzle.config.local.ts`, `drizzle.config.remote.ts`, `worker/database/database.ts`; test `test/worker/database/pgConnection.test.ts`.

**Interfaces produced:** `getPostgresClient(env): Sql` (postgres-js client, singleton per process), `buildDrizzle(env): PostgresJsDatabase<typeof schema>` (standalone → no-op), `isStandaloneRuntime` reused from `worker/utils/runtimeMode.ts`.

- [ ] **Step 1: add dep** — `bun add postgres` (postgres-js). Expected: `package.json` gains `"postgres"`.
- [ ] **Step 2: write failing test** — `test/worker/database/pgConnection.test.ts`: in standalone env (`RUNTIME_MODE='standalone'` via `buildEnvAdapter`-style object), `buildDrizzle(env)` returns a drizzle instance whose queries resolve to empty without a real connection (assert `await db.select().from(schema.systemSettings).limit(1)` resolves to `[]`, no throw, no network). Run: `bun run test -- test/worker/database/pgConnection.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement `noopPg.ts`** — a minimal no-op that satisfies `drizzle-orm/postgres-js`'s driver surface for the standalone path: since postgres-js drizzle calls the `sql` tagged template, provide a fake `Sql` whose query execution returns `[]`/`{ count: 0 }`. Implement `createNoopPostgres(): Sql` returning a callable tagged-template stub plus the methods drizzle invokes (`.unsafe`, `.begin`, `.end`). Model it on how `agent-runtime`'s `noopD1` was derived — READ `worker/database/noopD1.ts` for the pattern, and READ `node_modules/drizzle-orm/postgres-js/session.js` to see exactly which client methods drizzle calls, and stub only those. If the postgres-js drizzle driver's call surface is impractical to stub faithfully, FALL BACK to: keep `createNoopD1Database()` + `drizzle-orm/d1` ONLY for the standalone branch, and use postgres-js for the real branch — a dual-driver `DatabaseService` gated on `isStandaloneRuntime`. Document the choice.
- [ ] **Step 4: implement `pgConnection.ts`** — `getPostgresClient(env)` lazily constructs `postgres(env.SUPABASE_DB_URL, { prepare: false, ssl: 'require', max: 5 })` once per process (module-level cache), and `buildDrizzle(env)` returns `isStandaloneRuntime(env) ? drizzle(noop) : drizzle(getPostgresClient(env), { schema })`. (`prepare:false` is required for the Supabase transaction pooler.)
- [ ] **Step 5: rewrite `database.ts`** — replace the `drizzle-orm/d1` import + `DrizzleD1Database` type + the constructor's `Sentry.instrumentD1WithSentry`/`createNoopD1Database` branch with `buildDrizzle(env)`; DELETE `getReadDb()` + `withSession` + `enableReplicas` (D1 Sessions API — no Postgres equivalent). `db` type becomes `PostgresJsDatabase<typeof schema>`. `getHealthStatus` unchanged (queries `systemSettings`). Grep every `getReadDb(` caller (`rg -n "getReadDb" worker/`) and replace with `.db` (single connection).
- [ ] **Step 6: drizzle config** — both `drizzle.config.*.ts`: `dialect: 'postgresql'`, `dbCredentials: { url: process.env.SUPABASE_DB_URL! }`, `schema: './worker/database/schema.ts'`, `out: './supabase/migrations'`.
- [ ] **Step 7: verify + commit** — `bun run test -- test/worker/database/pgConnection.test.ts` PASS; `bun run typecheck` will still fail until schema.ts is pg (Task 2) — that's expected; note it. `bun test agent-runtime` green (standalone no-op path intact). Commit `feat: postgres connection module with standalone no-op seam, drop D1 read-replica`.

Note: this task intentionally leaves `bun run typecheck` RED (schema.ts is still sqlite) — Task 2 closes it. Acceptable under big-bang; the two tasks are a unit but split for review (connection vs schema).

---

### Task 2: Lean pg-core schema (rewrite `schema.ts`)

**Files:** rewrite `worker/database/schema.ts`; test `test/worker/database/schema.test.ts`.

**Interfaces produced:** Drizzle pg tables `users, apps, userModelConfigs, userModelProviders, userSecrets, rateLimitBuckets, systemSettings` + inferred `User/NewUser/App/NewApp/...` types. This is the single source `services/*` and `database.ts` import from.

- [ ] **Step 1: read the current sqlite schema** for the KEPT tables to copy real column names/enums: `rg -n "export const (users|apps|userModelConfigs|userModelProviders|systemSettings)" worker/database/schema.ts` then read those blocks. Note the columns the services actually use.
- [ ] **Step 2: write failing test** — `schema.test.ts` asserts the pg schema exports the 7 tables and that `apps` has pg column types (e.g. `getTableConfig(schema.apps)` columns include `created_at` of pg timestamp, `visibility`/`status` present, `deployment_id`). Run → FAIL.
- [ ] **Step 3: rewrite `schema.ts` with `drizzle-orm/pg-core`.** Complete table definitions:
  - `users`: `id uuid primaryKey` (references auth.users, but Drizzle needn't model the FK to the auth schema — just `uuid('id').primaryKey()`), `email text notNull`, `displayName`, `username unique`, `avatarUrl`, `provider text`, `createdAt timestamp{withTimezone}.defaultNow()`, `updatedAt`, `lastActiveAt`.
  - `apps`: port schema.ts:133-193 to pg — `id text pk`, `title`, `description`, `iconUrl`, `framework`, `originalPrompt`, `finalPrompt`, `userId uuid references users.id`, `sessionToken text`, `visibility text` (default 'private'), `status text` (default 'generating'), `deploymentId text`, `githubRepositoryUrl`, `githubRepositoryVisibility`, `screenshotUrl`, `screenshotCapturedAt timestamptz`, `isArchived boolean default false`, `isFeatured boolean default false`, `version integer default 1`, `parentAppId text`, `createdAt/updatedAt/lastDeployedAt timestamptz`. Indexes: userId, status, visibility, framework, createdAt, parentAppId.
  - `userModelConfigs`: `id text pk`, `userId uuid`, `agentActionName text`, `modelName`, `maxTokens integer`, `temperature doublePrecision`, `reasoningEffort text`, `providerOverride text`, `fallbackModel`, `isActive boolean default true`, timestamps. Unique(userId, agentActionName).
  - `userModelProviders`: `id text pk`, `userId uuid`, `name text`, `baseUrl`, `apiKeyEncrypted text`, `isActive boolean`, timestamps. Unique(userId, name).
  - `userSecrets`: `id text pk`, `userId uuid`, `secretType text`, `encryptedName bytea`, `nameNonce bytea`, `encryptedValue bytea`, `valueNonce bytea`, `metadata jsonb`, timestamps. Index userId. (bytea via `customType` or `text` base64 — pick per what the crypto module emits; check the secrets module.)
  - `rateLimitBuckets`: `id bigserial pk`, `key text notNull`, `bucketTimestamp bigint notNull`, `count integer notNull default 0`, `createdAt timestamptz.defaultNow()`. Unique(key, bucketTimestamp); index (key, bucketTimestamp desc), index createdAt.
  - `systemSettings`: `id text pk`, `key text unique notNull`, `value jsonb`, timestamps.
  - Export inferred types `type User = typeof users.$inferSelect; type NewUser = typeof users.$inferInsert;` etc. for the 7 tables. DELETE all other table exports and their types; `database.ts`'s re-export block (`worker/database/database.ts:19-26`) must be updated to only the surviving types.
- [ ] **Step 4: verify** — `schema.test.ts` PASS. `bun run typecheck` now surfaces every service/consumer still importing a deleted table (`Session`, `OAuthState`, etc.) — that's the Task 9/10 worklist; note the count. Commit `feat: rewrite database schema as lean pg-core core tables`.

---

### Task 3: Core Postgres migration + RLS (coexist with agent_*)

**Files:** create `supabase/migrations/20260708000001_core.sql`; test `test/worker/database/coreMigration.test.ts` (gated SUPABASE_LOCAL=1).

- [ ] **Step 1: write the migration SQL** (full DDL) creating the 7 tables to match the Drizzle schema exactly, then RLS:
  - `create table public.users (id uuid primary key references auth.users(id) on delete cascade, email text not null, display_name text, username text unique, avatar_url text, provider text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_active_at timestamptz);`
  - `apps`, `user_model_configs`, `user_model_providers`, `user_secrets`, `rate_limit_buckets`, `system_settings` per Task 2 columns.
  - `alter table … enable row level security;` on all 7.
  - Policies (user-owned): `create policy user_rw_apps on public.apps for all using (user_id = auth.uid()) with check (user_id = auth.uid());` and the same for `user_model_configs`, `user_model_providers`, `user_secrets`. `users`: `for all using (id = auth.uid()) with check (id = auth.uid())`. Add a public-read policy for `apps` where `visibility = 'public'` (`for select using (visibility = 'public')`). `system_settings`: no anon policy (service-role only). `rate_limit_buckets`: no anon policy (written by the API via service role).
  - Auto-provision profile: `create function public.handle_new_user() returns trigger language plpgsql security definer as $$ begin insert into public.users (id, email, display_name, avatar_url, provider) values (new.id, new.email, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url', new.raw_app_meta_data->>'provider') on conflict (id) do nothing; return new; end; $$;` + `create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`
  - Do NOT touch the agent_* tables/policies from `20260707000001_agent_runtime.sql`.
- [ ] **Step 2: gated integration test** — `coreMigration.test.ts` (`describe.skip` unless `SUPABASE_LOCAL=1`): with service role, insert a `users` row + an `apps` row and read them back; assert an anon client (no auth) cannot read a private app. Skips cleanly by default.
- [ ] **Step 3: verify** — `bun test agent-runtime` unaffected; the gated test skips. Optionally (Docker): `bunx supabase db reset` applies both migrations cleanly (agent_* + core coexist). Commit `feat: core postgres schema migration with auth.uid RLS`.

---

### Task 4: Supabase Auth adapter (replace JWTUtils/SessionService)

**Files:** create `worker/services/auth/supabaseAuth.ts`; test `test/worker/services/auth/supabaseAuth.test.ts`.

**Interfaces produced:** `getUserFromToken(env, accessToken): Promise<AuthUser | null>` (validates via `supabase.auth.getUser(token)`), `requireUser(env, request): Promise<AuthUser>` (extracts bearer/cookie token, throws 401 shape on miss), `AuthUser = { id: string; email: string; displayName?: string }`.

- [ ] **Step 1: read the current auth touchpoints** to preserve the `AuthUser`/`RouteContext.user` shape callers expect: `rg -n "context.user|RouteContext|AuthUser" worker/api worker/types/auth-types.ts | head`. Match the field names controllers read (`user.id`, `user.email`).
- [ ] **Step 2: write failing test** — with a fake supabase client whose `auth.getUser(token)` returns `{ data: { user: { id, email } }, error: null }` for a good token and `{ data: { user: null }, error: {...} }` for a bad one, assert `getUserFromToken` returns the mapped `AuthUser` / `null`. Run → FAIL.
- [ ] **Step 3: implement** — `getUserFromToken` builds `createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)` and calls `auth.getUser(accessToken)`; maps to `AuthUser`. `requireUser` pulls the token from `Authorization: Bearer` (2c will send the Supabase session token) or the `sb-…-auth-token` cookie, calls `getUserFromToken`, throws a typed `UnauthorizedError` on null. Inject the supabase client factory for testability.
- [ ] **Step 4: verify + commit** — test PASS; `bun run typecheck` still shows the not-yet-deleted old-auth references (Task 9). Commit `feat: supabase auth adapter replacing hand-rolled jwt/session`.

---

### Task 5: AppService → Postgres + tests
**Files:** modify `worker/database/services/AppService.ts`, `BaseService.ts`; test `test/worker/database/appService.test.ts`.
- [ ] Read `AppService.ts` + `BaseService.ts`. Replace `getReadDb('fast'|'fresh')` calls with `this.database.db`. Replace `strftime('%s','now')` with `sql\`extract(epoch from now())\``; any `.get()` (D1) → drizzle-pg `.then(r => r[0])`/`.limit(1)`; `.run()` → drizzle-pg execute; `userId` filters now `uuid`. Keep method signatures identical.
- [ ] Test (gated SUPABASE_LOCAL=1 for live queries; unit-test the pure query-builder shape where possible): create app → getApp → updateDeploymentId → list-by-user. Run → PASS. Commit `feat: port AppService to postgres`.

Note: replicate this port pattern for **UserService** in the same task if small (read it first); otherwise a sibling task.

---

### Task 6: ModelConfigService + ModelProvidersService → Postgres + tests
**Files:** modify those two services; tests.
- [ ] Port both to `this.database.db` (pg). ModelConfigService's `getModelConfigsInfo` already has the Phase-1 standalone defaults branch — keep it; the real branch now reads pg. Preserve the `{agents, userConfigs, defaultConfigs}` shape. Commit `feat: port model config + providers services to postgres`.

---

### Task 7: user_secrets Postgres store (crypto unchanged)
**Files:** create `worker/services/secrets/secretsStore.ts`; test.
- [ ] Read `worker/services/secrets/UserSecretsStore.ts` + its crypto helpers. Extract the STORAGE into `secretsStore.ts`: `storeSecret(db, userId, {encryptedName,nameNonce,encryptedValue,valueNonce,secretType,metadata})`, `listSecrets(db, userId)`, `getSecret(db, userId, id)`, `deleteSecret(db, userId, id)` over the `userSecrets` pg table. The XChaCha20/VMK-SK crypto is UNCHANGED (client-derived keys; server stores ciphertext only). The old DO WebSocket interface is retired (2b adds REST endpoints).
- [ ] Test: round-trip store→get→list→delete with fixed ciphertext bytes; assert the server never sees plaintext (only bytea in/out). Commit `feat: postgres-backed user secrets store`.

---

### Task 8: rate_limit_buckets Postgres store
**Files:** create `worker/services/rate-limit/pgRateLimitStore.ts`; test.
- [ ] Read `DORateLimitStore.ts` + `KVRateLimitStore.ts` for the sliding-window algorithm (bucket size, main/burst/daily windows, calendar-day reset). Reproduce over `rateLimitBuckets`: increment = `insert … on conflict (key,bucket_timestamp) do update set count = count + 1`; window count = `select coalesce(sum(count),0) where key=$1 and bucket_timestamp > $2`; cleanup = `delete where created_at < now() - interval`. Expose `checkAndIncrement(db, key, config): { allowed, remaining }` matching the existing `RateLimitStore` contract (`rg -n "interface RateLimitStore|RateLimitResult" worker/services/rate-limit`).
- [ ] Test the window math with a fake db (in-memory bucket map applying the same conflict/sum semantics): N increments within window → allowed until limit, then blocked; buckets outside window ignored. Commit `feat: postgres rate limit store reproducing DO window algorithm`.

---

### Task 9: system_settings store + retire KV config; delete auth-subsumed tables/services
**Files:** create `worker/services/config/systemSettingsStore.ts`; delete `AuthService.ts`, `SessionService.ts`, `ApiKeyService.ts` and the OAuth services + JWT/session utils; fix all compile fallout.
- [ ] `systemSettingsStore`: `getSetting(db,key)`, `setSetting(db,key,value)` over `systemSettings` (jsonb). Replace `env.VibecoderStore` CONFIG_KEY/user_config reads (`config/index.ts`) with these + `userModelConfigs`. 
- [ ] Delete the hand-rolled auth stack now subsumed by Supabase Auth: `worker/services/oauth/*`, `worker/utils/jwtUtils.ts`, `SessionService.ts`, `AuthService.ts`, `ApiKeyService.ts`, and the CSRF/session utils no longer referenced. Then `bun run typecheck` and fix EVERY reference (controllers that used them will be rewritten in 2b — for 2a, stub the controller imports to the new `supabaseAuth` adapter or delete the route registrations, whichever keeps typecheck green; the API fully moves in 2b). This is the task that reconciles the big-bang deletions.
- [ ] Commit `refactor: retire hand-rolled auth + KV config, adopt supabase auth + system_settings`.

Note: this task is where the Workers *runtime* may become non-functional (routes referencing deleted services). Acceptable per big-bang (2b rebuilds the API on Vercel). The gate is TYPECHECK green + agent-runtime tests green, NOT a running Worker.

---

### Task 10: Verification sweep + coexistence + runbook
**Files:** create `docs/phase2a-notes.md`; ledger.
- [ ] Gates: `bun run typecheck` + `bun run typecheck:agent-runtime` clean; `bun test agent-runtime` green (standalone no-op DB seam still works — verify explicitly, this is the Phase-1 coexistence guarantee); `bun run test` for the worker unit tests that survive (note any that are now obsolete/removed with the deleted services).
- [ ] Coexistence check: `bunx supabase db reset` (if Docker) applies `20260707000001_agent_runtime.sql` + `20260708000001_core.sql` cleanly; agent_* RLS untouched; a session-JWT still scopes agent_* while a user-JWT scopes the core tables.
- [ ] `docs/phase2a-notes.md`: retired tables/services list, the postgres connection + no-op seam, deferred tables (social/analytics/apiKeys/cloudflareAccounts/aiGateways), and the DEFERRED live verifications (Docker: `SUPABASE_LOCAL=1 bun run test` for the gated core/migration/rate-limit/secrets integration tests). Commit `chore: phase 2a verification sweep and notes`.

---

## Self-Review Notes (applied)
- Brief's kept-tables (users/apps/model-configs/model-providers/user_secrets/rate_limit/system_settings) → Tasks 2/3 create all 7; deferred set explicitly out of scope.
- Supabase-Auth-subsumes-8-tables → Task 9 deletes them; Task 4 adds the adapter; RLS auth.uid() in Task 3.
- The ONE architectural risk (standalone no-op DB after the D1→pg swap) → Task 1 Step 3/4 preserve `isStandaloneRuntime → no-op`, with an explicit dual-driver fallback if the postgres-js no-op stub is impractical; Task 10 verifies agent-runtime stays green.
- D1 read-replica `withSession` removal → Task 1 Step 5.
- Type/name consistency: `buildDrizzle`/`getPostgresClient` (T1) consumed by `database.ts`; the 7 table names + inferred types (T2) consumed by every service task; `AuthUser` (T4) consumed by 2b.
- Placeholder scan: service-port tasks intentionally say "read the current file + apply these exact transforms" rather than reproducing entire existing service bodies — the transforms are concrete (getReadDb→.db, strftime→extract(epoch), .get→.limit(1)); the NEW files (connection, migration, auth adapter, secrets store, rate store, settings store) carry complete specs.

## Execution
Subagent-driven, task-by-task, fresh implementer + reviewer each, Workers typecheck + agent-runtime tests green at every gate. Tasks 1+2 are a coupled unit (typecheck goes red between them) — review them together or accept T1's documented red. Live-Postgres integration tests are Docker-gated and deferred to a Supabase-capable env (same pattern as Phase 1).
