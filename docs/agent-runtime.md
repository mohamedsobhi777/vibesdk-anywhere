# Standalone Agent Runtime

## What this is

`agent-runtime/` is a standalone Bun process that replaces the Cloudflare
Workers `CodeGeneratorAgent` Durable Object for one chat session. It reuses
the same `worker/agents` behavior tree (`AgenticCodingBehavior`,
`PhasicCodingBehavior`, `ProjectObjective`, `FileManager`, `StateManager`,
`DeploymentManager`, git, tools) but swaps every Workers-only infrastructure
seam for a plain-Node/Bun equivalent:

| Concern | Workers (Durable Object) | Standalone (`agent-runtime/`) |
|---|---|---|
| State | Durable Object storage | Postgres (`agent_state` table, debounced upsert) |
| Realtime transport | PartySocket / Workers WebSocket | Supabase Realtime private broadcast channel |
| Sandbox | `Sandbox` binding (container service) | `LocalSandboxService` — real fs + child-process exec on the host |
| Git | isomorphic-git + SQLite filesystem adapter | isomorphic-git + real filesystem (path-rebasing Node fs adapter) |
| Template source | R2 bucket binding | HTTP fetch against `TEMPLATES_BASE_URL` |

The entrypoint is `agent-runtime/src/main.ts`. It boots exactly one
`StandaloneAgent` (`agent-runtime/src/standaloneAgent.ts`) for the session
named by `SESSION_ID` and keeps the process alive until `SIGTERM`/`SIGINT`.
One process serves one session — there is no multi-tenancy inside a single
agent-runtime process.

`StandaloneAgent` implements the same `AgentHost` interface the Workers
`CodeGeneratorAgent` implements, so the WebSocket message handler
(`worker/agents/core/websocket.ts`) and every behavior/tool that calls
`agent.broadcast(...)` runs unmodified — broadcasts funnel through
`broadcastToConnections()` on both hosts, only the underlying transport
implementation differs (see "Protocol parity" below).

## Environment contract

Parsed and validated by `agent-runtime/src/bootstrapEnv.ts`
(`parseBootstrapEnv`). Missing required vars throw one aggregated error
listing every missing key.

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_ID` | Yes | Chat session id; primary key for `agent_sessions`/`agent_state`, and the Realtime topic suffix (`session:{id}`) |
| `AGENT_ID` | Yes | Agent identifier passed to `StandaloneAgent.boot()` |
| `SUPABASE_URL` | Yes | Supabase project URL (PostgREST + Realtime) |
| `SUPABASE_ANON_KEY` | Yes | Project anon key — mandatory `createClient()` argument; sent as the `apikey` header on every PostgREST/Realtime request |
| `SUPABASE_SESSION_JWT` | Yes | Short-lived, session-scoped JWT. Layers on top of the anon key via `Authorization: Bearer` (PostgREST/RLS) and `realtime.setAuth()` (Realtime channel authorization) |
| `TEMPLATES_BASE_URL` | Yes | HTTP base URL the agent fetches project templates from (replaces the R2 template bucket) |
| `WORKSPACE_DIR` | No (default `/workspace`) | Local directory the git checkout and sandbox exec live in |
| `SELF_PREVIEW_BASE_URL` | No | Base URL used to construct the dev-server preview link surfaced to the client |
| `CLOUDFLARE_AI_GATEWAY_URL` | No | Routes LLM calls through Cloudflare AI Gateway if set |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | No | Auth token for the AI Gateway, if used |

Any Workers-only binding (`AI`, `DB`, `Sandbox`, `DISPATCHER`,
`CodeGenObject`, `UserSecretsStore`, `THINK_DO`, `SPACE_DO`,
`TEMPLATES_BUCKET`, `VibecoderStore`) is present on the adapted `Env` object
(`agent-runtime/src/envAdapter.ts`) as a poisoned `Proxy` — any worker-tree
code path that still tries to touch one of these throws immediately and by
name (`Unsupported binding "X" in standalone agent runtime`), rather than
failing silently or with an unrelated TypeError.

## Local dev loop

Requires a local Supabase stack (Docker-backed):

```bash
# 1. Start the local stack (Postgres + Realtime + Auth + Studio)
bunx supabase start

# 2. Apply the agent-runtime schema migration
#    (supabase/migrations/20260707000001_agent_runtime.sql)
bunx supabase db reset

# 3. Run the gated integration tests against the live local stack
#    (schema.integration.test.ts + e2e.integration.test.ts — both skip
#    unless SUPABASE_LOCAL=1)
SUPABASE_LOCAL=1 bun test agent-runtime

# 4. Run one full smoke session directly
bun scripts/agent-runtime/dev-session.ts --query "build a todo app"
```

`scripts/agent-runtime/dev-session.ts` (`runSmokeSession`) seeds an
`agent_sessions` row via the Supabase service-role key, signs a matching
session JWT, spawns `bun agent-runtime/src/main.ts` as a child process with
the full env contract above, subscribes to `session:{id}` as a browser-side
Realtime client, sends `get_model_configs`, waits for the
`model_configs_info` reply, tears the agent process down, and asserts
`agent_state` persisted a row. No LLM call is made — `get_model_configs` is
a pure config read — so no provider API key is required for this smoke
path. The seeded `agent_sessions` row is deleted in a `finally` block
covering the entire run, so a failed run (timeout, early agent exit, or a
failed assertion) does not leave an orphaned row in the local stack.

## Staging sandbox boot

Two staging-only scripts under `scripts/superserve/` (manual tools, never
run in CI, verified by type-checking only):

```bash
# 1. Build (or rebuild) the SuperServe template the agent process runs in.
#    Clones the supervibe repo server-side at a pinned ref and pre-installs
#    Node 22 + bun + `bun install`, so boot only has to start the process.
SUPERSERVE_API_KEY=ss_live_... bun run scripts/superserve/build-agent-template.ts

# 2. Boot a sandbox from that template and start the agent inside it,
#    detached, for one session.
SUPERSERVE_API_KEY=ss_live_... \
SESSION_ID=... AGENT_ID=... \
SUPABASE_URL=https://xyzcompany.supabase.co \
SUPABASE_ANON_KEY=... SUPABASE_SESSION_JWT=... \
TEMPLATES_BASE_URL=https://templates.example.com \
bun run scripts/superserve/boot-agent-sandbox.ts
```

**Hosted Supabase is a hard requirement for staging.** The agent process
inside a SuperServe sandbox reaches `SUPABASE_URL` over the public internet
(PostgREST + Realtime); a cloud sandbox's network namespace cannot route to
a laptop's `127.0.0.1`/`localhost` Supabase instance. `SUPABASE_URL` must
point at a real hosted project (`https://<ref>.supabase.co`) before running
`boot-agent-sandbox.ts` — the local dev loop above is Docker/local-stack
only and does not apply here.

## Type-checking: two scoped gates, not one

```bash
bun run typecheck               # tsc -b --incremental --noEmit (Workers tree)
bun run typecheck:agent-runtime # tsc -p agent-runtime --noEmit (agent-runtime tree)
```

These are two separate gates by necessity, not oversight: **one tsconfig
cannot cleanly type-check both the Bun-native and Workers-native code in
this repo at once.** `agent-runtime/` imports large parts of `worker/agents`
directly (to reuse the behavior tree without a fork), but that same
`worker/` tree also contains code that only type-checks under the Workers
toolchain — `?raw` imports that need `vite/client` ambient types,
Cloudflare container class fields (`!`-definite-assignment on Durable
Object bindings), and `workers-types` `fetch`/`Uint8Array` shapes that
don't structurally match Bun's DOM-less lib target. Compiling
`agent-runtime` with a single shared tsconfig against all of that
transitively errors on files agent-runtime never touches at runtime.

The resolution: `typecheck:agent-runtime` filters `tsc -p agent-runtime`
output to only fail on diagnostics whose path is under `agent-runtime/`
(`grep -E '^agent-runtime/'`, inverted with `!`) — i.e. the gate is **zero
agent-runtime-owned errors**, not zero errors across every file the
compiler happens to visit. The rest of the tree (everything under
`worker/`) is covered by the ordinary Workers-targeted `bun run typecheck`
(`tsc -b`), which passes cleanly on its own tsconfig project references.
Both gates must pass; together they cover the whole repo without requiring
one config to serve two incompatible runtimes.

## Outstanding live verifications (deferred)

Docker was unavailable in the environment this runtime was built in, so two
verifications have **never been run against a live stack** and must run in
a Docker-capable environment before Phase 1 is considered production-trusted:

1. **Realtime/RLS policy verification.** The `realtime.messages` RLS
   policies added by `supabase/migrations/20260707000001_agent_runtime.sql`
   (session-scoped read/write via `auth.jwt() ->> 'session_id'`) have only
   been reviewed by inspection, never exercised against a running Supabase
   Realtime server. Run:

   ```bash
   bunx supabase start
   bunx supabase db reset
   SUPABASE_LOCAL=1 bun test agent-runtime
   ```

   This runs `agent-runtime/test/schema.integration.test.ts` (schema-level
   assertions) and `agent-runtime/test/e2e.integration.test.ts` (full
   client-channel subscribe/broadcast round trip), both gated behind
   `SUPABASE_LOCAL=1` and `describe.skip`-ed otherwise.

2. **Full e2e smoke.** `scripts/agent-runtime/dev-session.ts` exercises
   boot → `agent_connected` snapshot broadcast → `get_model_configs` →
   `model_configs_info` round trip → `agent_state` persistence, end to end,
   against a real spawned agent process and a real Realtime channel. It has
   been written and reviewed but not run, for the same Docker-availability
   reason.

Until both have run clean against a live local stack, treat the
Realtime/RLS authorization surface as reviewed-but-unverified.

## Phase-1 stubs

Deliberately unimplemented in this phase, with the reference Workers
behavior each one replaces:

| Stub | Reference behavior (Workers) | Standalone behavior | Picked up |
|---|---|---|---|
| `think` behavior | `ThinkCodingBehavior` (Durable Object) | Explicit requests for `think` reject with an error. **Product note:** the repo's current default (`getBehaviorTypeForProject('app')`) resolves to `'think'`, but that default was never an explicit ask for `think` — a bare boot with no persisted state and no `initArgs.behaviorType` silently falls back to `'agentic'` instead of rejecting. Standalone phase-1 runs `agentic` where the Workers agent would run `think` for default `app` projects. Only a **persisted** or **explicitly requested** `think` rejects. | Later phase (`think` port) |
| User secrets vault | `UserSecretsStore` Durable Object client, `handleVaultUnlocked`/`handleVaultLocked` wiring live model-config decryption | No-op handlers (`standaloneAgent.ts`) — the standalone runtime has no vault client at all | Later phase |
| Screenshots / browser console capture | Browser rendering binding, screenshot tool | Not implemented | Later phase |
| GitHub export | Git export tool/controller | Not implemented | Later phase |
| `deployToCloudflareWorkers` | Live Cloudflare Workers deploy via the `Sandbox` binding | `LocalSandboxService.deployToCloudflareWorkers()` returns `{ success: false, error: 'unsupported' }` — reachable through `deployProject()` → `ProjectObjective.deploy()`, same call path as Workers, but the sandbox layer declines gracefully instead of deploying | Later phase |
| `exportGitObjects` | Raw isomorphic-git object export (used by `GitVersionControl.getStorageStats`/export tooling) | Throws `git object export is unsupported in the standalone agent runtime (phase 1)` — the injected real-fs git adapter doesn't support the SQLite-only export path the Workers adapter uses | Later phase |
| D1 `AppService` side-writes | `codingAgent.ts`'s `saveToDatabase()` creates an `AppService`(D1)-backed app row on generation start | Not called at all — `StandaloneAgent` has no equivalent method | Later phase |
| `ModelConfigService` user-config read | D1 read of the user's per-action model config overrides, applied before `AGENT_CONFIG` defaults | Skipped entirely — `behavior.setUserModelConfigs(undefined)` — every action falls back to `AGENT_CONFIG` defaults | Later phase |
| Usage / rate-limit check on `user_suggestion` | Rate-limit gate before processing a user-suggested next step | Not implemented | Later phase |

## Protocol parity

`worker/agents` uses 77 distinct `WebSocketMessageResponses.*` response
constants (`rg -o "WebSocketMessageResponses\.[A-Z_]+" worker/agents | sort -u | wc -l`).
Every one of them is ultimately sent through
`broadcastToConnections()`/`agent.broadcast()` (`worker/agents/core/websocket.ts`),
which both the Workers `CodeGeneratorAgent` and `StandaloneAgent` call
identically — `StandaloneAgent.broadcast()` is a direct passthrough to
`broadcastToConnections(this, type, data)`. Only the transport underneath
differs (PartySocket vs. Supabase Realtime channel); the message shapes,
types, and call sites are untouched. Because `broadcastToConnections` and
every message type/data shape it accepts are declared once in
`worker/api/websocketTypes.ts` and consumed identically by both hosts, the
ordinary Workers-targeted `bun run typecheck` (`tsc -b`) passing across the
whole `worker/agents` tree **is** the protocol-parity proof: if any
response constant's payload shape had drifted between what a behavior
sends and what `AgentHost`/the transport can carry, `tsc -b` would fail to
compile before this runbook could ever be written. No separate
message-by-message parity test is needed for phase 1.

## State persistence caveat: debounced writes can lose the tail

`agent-runtime/src/stateStore.ts`'s `createStateStore()` debounces
`persist()` calls (default 300ms — `persist()` resets a timer on every
call; `write()` only fires once calls stop arriving for that long). This
keeps Postgres write volume sane during rapid state churn (e.g. streaming
file generation), but it means **a process crash can lose up to the last
debounce window (~300ms) of state** that was `persist()`-ed but never
flushed to `agent_state`. `StateStore.flush()` exists and is called on
graceful shutdown (`SIGTERM`/`SIGINT` → `agent.shutdown()`), but an
ungraceful crash (OOM, `SIGKILL`, host failure) bypasses it entirely.

The schema already includes `agent_messages`
(`supabase/migrations/20260707000001_agent_runtime.sql`) as a real,
RLS-enabled table, created for exactly this purpose but not yet written to
by the state or conversation stores. The intended fix in a later
hardening pass is to append every state-changing message to
`agent_messages` as it's produced (an append-only log, not a debounced
upsert of a single row), so a crash-recovery boot can replay from the log
instead of relying solely on the last successfully-debounced `agent_state`
snapshot. This is out of scope for Phase 1.
