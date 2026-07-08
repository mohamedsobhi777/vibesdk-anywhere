# Phase 2a Scope Brief — Data + Auth Foundation (greenfield)

**Parent:** `docs/superpowers/specs/2026-07-07-vibesdk-anywhere-replatform-design.md` (approved design)
**Phase 1 (done, sound):** standalone agent runtime in `agent-runtime/`, Supabase migration `supabase/migrations/20260707000001_agent_runtime.sql` (agent_sessions/state/messages/conversations, session_id-claim RLS).

## Locked decisions (user, 2026-07-08)
1. **Greenfield.** Zero users, prototype, NO production data, NO data migration. Define schema fresh.
2. **Big-bang** cutover to Vercel + Supabase. Do NOT keep Cloudflare alive; no dual-run, no feature flags, no incremental-cutover plumbing.
3. **Full-stack** in Phase 2 (frontend + backend), but 2a is the backend foundation; frontend lands in 2c.
Make every ambiguous call independently; move fast; keep the review loop (it caught real bugs in Phase 1).

## 2a goal
The Postgres data layer + Supabase Auth that the Vercel API (2b) and frontend (2c) sit on. Deliverable: Drizzle-over-Postgres schema + services that compile and unit-test green, Supabase Auth wired, RLS enforced, the two stateful DOs (secrets, rate-limit) reborn as Postgres.

## KEY SIMPLIFICATION — Supabase Auth subsumes ~8 tables
Adopting Supabase Auth (design decision #3) means these current D1 tables are DROPPED, not ported (Supabase handles them natively): `sessions`, `oauthStates`, `authAttempts`, `passwordResetTokens`, `emailVerificationTokens`, `verificationOtps`, and the session/JWT machinery. `apiKeys` deferred (not on the prototype's login→create→generate→preview path). So the greenfield core is ~7 tables, not 24.

## Lean core schema (Postgres, in `supabase/migrations/`, coexisting with the Phase-1 agent_* tables)
- `users` — profile extension of Supabase `auth.users` (PK = `id uuid references auth.users(id)`), carrying vibesdk fields (displayName, username, avatar, provider, timestamps). NOT a standalone identity table anymore.
- `apps` — the generated apps (port from schema.ts:133-193 minus D1-isms: int-ts→timestamptz, int-bool→boolean, text-json→jsonb; keep visibility/status/framework enums, parentAppId, deploymentId).
- `user_model_configs` + `user_model_providers` — per-user LLM config/BYOK (schema.ts:511-554).
- `user_secrets` — the vault (recreate; migration 0003 had dropped it). App-layer XChaCha20 unchanged; store ciphertext/nonce as `bytea`, keyed by user_id.
- `rate_limit_buckets` — replaces DORateLimitStore: `(key, bucket_timestamp, count)` UNIQUE(key,bucket_timestamp), UPSERT increment, TTL cleanup.
- `system_settings` — global config (schema.ts:563), was KV CONFIG_KEY.
DEFER to a later sub-phase (not needed for the core loop): favorites, stars, appLikes, commentLikes, appComments, appViews, auditLogs, cloudflareAccounts, aiGateways, apiKeys.

## RLS model (coexistence)
- User-owned tables (apps, user_model_configs, user_model_providers, user_secrets): RLS `USING (user_id = auth.uid())` — Supabase Auth JWT.
- Phase-1 agent_* tables: KEEP their existing `session_id`-claim RLS untouched (the API mints a short-lived session-scoped JWT for the agent sandbox; the two coexist — user JWT for user tables, session JWT for agent tables).

## Data-layer port facts (from research)
- Drizzle: `drizzle.config.*.ts` dialect `sqlite`/`d1-http` → `postgresql`; driver → `postgres-js` (or `pg`) against the Supabase pooler connection string. `drizzle-orm/d1` → `drizzle-orm/postgres-js`.
- `worker/database/database.ts`: `drizzle(env.DB,...)` → `drizzle(postgres(SUPABASE_DB_URL),...)`. REMOVE the D1 `withSession()` read-replica logic (`getReadDb('fast'/'fresh')` → single connection; `ENABLE_READ_REPLICAS` retired) — D1 Sessions API has no Postgres equivalent.
- SQLite→Postgres per-column: integer-ms timestamps → `timestamptz` (or `bigint` if math depends on ms — check each service), int-boolean → `boolean`, text-mode-json → `jsonb`, `authAttempts` autoincrement gone with the table, REAL → `double precision`/`numeric`.
- 10 db services under `worker/database/services/` — AppService/UserService/ModelConfigService/ModelProvidersService keep their method contracts; AuthService/SessionService/ApiKeyService largely REPLACED by Supabase Auth (thin adapters or removed). `strftime('%s','now')` → `extract(epoch from now())`.
- UserSecretsStore (`worker/services/secrets/`): app-layer XChaCha20-Poly1305, VMK/SK client-derived (never server-side) → port storage to `user_secrets` Postgres rows; the crypto is unchanged. It was WebSocket-DO; becomes REST + Postgres (2b wires the endpoints; 2a provides the store).
- Note the `runtimeMode.ts` seam + `noopD1` from the Phase-1 C1/C2 fix: the standalone agent runtime relies on `env.DB` being absent/no-op. After the D1→Postgres swap, ensure the standalone path still gets a no-op DB (it does not use the real Postgres); keep that seam working.

## Coexistence with Phase 1
Same `supabase/migrations/` dir. New migration(s) ADD the core tables + RLS; do NOT alter the agent_* tables or their policies. Supabase Auth (`auth.users`) is additive. The Phase-1 agent runtime keeps its session-JWT model; user-facing auth is Supabase Auth — both valid concurrently.

## Constraints
- No `any`; no emojis; Drizzle Postgres idioms. Keep the Cloudflare Workers build compiling until 2b physically removes it (2a swaps the DB layer — the Workers app may not fully run mid-2a, but must typecheck; if a clean mid-state is impossible, note it and gate behind the big-bang assumption).
- bun; new deps: `postgres` (postgres-js) + `@supabase/supabase-js` (already present from Phase 1). drizzle-kit for Postgres migrations.
- Tests: unit-test the pure port logic (schema shape, rate-limit bucket math, secrets store) with fakes; live Postgres integration tests gated on `SUPABASE_LOCAL=1` (Docker — deferred here, run in staging).

## Out of scope for 2a (later sub-phases)
- 2b: Vercel/Hono API routes, agent bridge (Superserve control plane + Realtime + Postgres state/tickets), the REST endpoints over the secrets store.
- 2c: frontend (Supabase client SDK, token auth, WebSocket→Realtime), end-to-end vertical.
- Deferred tables (social/analytics), apiKeys, cloudflareAccounts/aiGateways (Cloudflare-AI-Gateway BYOK — re-evaluate under the direct-SDK model).
