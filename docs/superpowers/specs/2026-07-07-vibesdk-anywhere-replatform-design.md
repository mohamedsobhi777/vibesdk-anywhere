# vibesdk Anywhere: Vercel + Supabase + Superserve Re-Platform

**Status:** Approved design (user-approved 2026-07-07)
**Supersedes:** the Workers-targeted scope of `.context/superserve-sandbox-migration-PRD.md` (its sandbox/backend research and harness/template work carry forward; its provider-behind-a-flag architecture does not)
**Related branch state:** `mohamedsobhi777/sandbox-provider-migration-assessment` parked after Task 2 (see `.superpowers/sdd/progress.md`)

## 1. Goal

Make vibesdk an OSS project that runs locally, deploys without Cloudflare lock-in, and uses Superserve sandboxes for all generated-app compute — including the per-session agent itself.

Target stack: **Vercel** (frontend + API), **Supabase** (Postgres, Auth, Realtime, Storage), **Superserve** (agent sandboxes, preview/deploy sandboxes).

## 2. Decisions (user-settled in brainstorming, 2026-07-07)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Agent runtime | **Agent-in-sandbox:** one Superserve sandbox per active chat session runs the agent as a long-lived Bun process; it owns its filesystem, dev server, and git. Replaces the `CodeGeneratorAgent` Durable Object. |
| 2 | Browser ↔ agent transport | **Supabase Realtime** per-session broadcast channel. No WebSocket hosting of our own; Vercel functions stay stateless. |
| 3 | Auth | **Supabase Auth** (Google/GitHub OAuth), replacing the hand-rolled OAuth+JWT stack. RLS everywhere. *(Recommendation accepted with design approval.)* |
| 4 | Preview/deployed-app URLs | **Direct sandbox preview URLs** (`{port}-{id}.sandbox.superserve.ai`), branded wildcard CNAME onto the Superserve edge when available. No vibesdk-side proxy. *(Recommendation accepted with design approval; reverses the old "never expose superserve.ai" decision.)* |
| 5 | Credentials in agent sandboxes | None long-lived. LLM keys via Superserve egress-injected secrets; Supabase access via short-lived session-scoped JWT + RLS; Superserve API key lives only in the Vercel API. |
| 6 | Durable source of truth | Postgres. Sandbox filesystems (including git history and node_modules) are rebuildable caches; a destroyed sandbox is rehydrated from Postgres state. |
| 7 | Cloudflare path | Deleted at cutover (Phase 4), not flag-retained. The re-platform is a new deployment target, not a runtime branch. |

## 3. Architecture

```
Browser (React SPA, Vite)
  ├── HTTPS → Vercel API routes (app CRUD, session bootstrap, deploys, templates)
  ├── Supabase Auth (OAuth, JWT)
  ├── Supabase Realtime channel session:{sessionId}  ⇄  Agent process
  └── iframe → https://{port}-{sandboxId}.sandbox.superserve.ai   (preview + HMR WS, direct)

Vercel API (Node serverless; sole holder of SUPERSERVE_API_KEY)
  ├── Supabase Postgres (Drizzle) — apps, users, sessions, deploy mappings, rate limits, encrypted user secrets
  ├── Superserve control plane — create/resume/pause/kill sandboxes; attach egress secrets
  └── Vercel Cron — idle-session sweep (pause), orphan sweep (kill)

Superserve agent sandbox (one per active session, template: vibesdk-agent)
  ├── Agent process (Bun): state machine, phase generation, tools, deep debugger
  ├── LocalSandboxService (BaseSandboxService impl over local fs/exec)
  ├── Dev server (bun run dev, separate unix user), real git, Playwright screenshots
  ├── supabase-js: Realtime publish/subscribe + state persistence (session-scoped JWT)
  └── LLM calls with egress-injected provider keys

Superserve deploy sandbox (one always-on per deployed app)
  └── bun run preview under the monitor-cli harness (unchanged from parked-branch design)
```

### 3.1 Vercel layer

- The React SPA deploys as static assets (Vite build unchanged; `src/` largely untouched except transport and auth clients).
- The existing `worker/api` controllers/routes port to a single Node serverless entry (Hono router) under `api/`. Handlers keep their shapes; `env` access, D1/KV/R2 bindings, and DO stubs are replaced by Postgres queries and Superserve control-plane calls.
- Endpoints that today talk to the agent DO (`getAgentStub`) become either (a) Realtime messages to the agent channel or (b) Postgres reads of agent-persisted state.
- Deploy, sandbox-lifecycle, and secret-attachment operations are API-only: browsers and agent sandboxes never hold the Superserve API key.

### 3.2 Supabase layer

- **Postgres:** Drizzle schema ports from SQLite to Postgres. New tables:
  - `agent_sessions(session_id pk, user_id, app_id, sandbox_id, status enum(provisioning|active|paused|dead), last_activity_at, created_at)`
  - `deployments(deployment_id pk = project name, app_id, sandbox_id, port, created_at)` — replaces the KV mapping
  - `rate_limits(key pk, window_start, count)` — replaces `DORateLimitStore`
  - `user_secrets(id, user_id, name, ciphertext, nonce, key_version, ...)` — replaces the `UserSecretsStore` DO; the existing XChaCha20-Poly1305 app-layer encryption and key-derivation hierarchy is preserved on top of Postgres rows
  - `agent_state(session_id pk, state jsonb, updated_at)` + `agent_messages(session_id, seq, payload jsonb)` — authoritative agent state snapshot and message log for reconnect/state restoration
- **Auth:** Supabase Auth with Google + GitHub providers. The `users` table keys off `auth.users.id`. Anonymous sessions (today's `sessionToken` apps) map to Supabase anonymous sign-in.
- **Realtime:** private broadcast channel `session:{sessionId}`, authorized via RLS on `realtime.messages` so only the session's owner (or its agent JWT) can join. Message payloads reuse the existing WebSocket message types from `worker/api/websocketTypes.ts` verbatim — the transport changes, the protocol does not. The agent also persists every state-changing message to `agent_messages`, and emits the same `agent_connected` snapshot on (re)subscription, reproducing today's reconnect semantics.
- **Storage:** buckets for template zips (was `TEMPLATES_BUCKET` R2) and app screenshots. Template catalog JSON moves with them.

### 3.3 Superserve layer

- **Agent sandbox** (template `vibesdk-agent`): Ubuntu + Bun + Node + git + Playwright/Chromium + the agent bundle. The agent process:
  - subscribes/publishes on its session channel; heartbeats `last_activity_at`
  - runs the generation state machine (IDLE → PHASE_GENERATING → PHASE_IMPLEMENTING → REVIEWING) exactly as today — the agent core (`worker/agents/`) is ported, not rewritten; its DO storage calls become `agent_state`/`agent_messages` writes
  - implements `BaseSandboxService` as `LocalSandboxService`: writeFiles → local fs, executeCommands → local exec, dev server → local supervised process (the `container/` ProcessMonitor runs in-process), logs/errors → local bun:sqlite, static analysis → local tsc/eslint
  - uses real git on the workspace dir (replaces isomorphic-git-over-DO-SQLite and `SpaceDO`)
  - takes screenshots of its own dev server with Playwright (replaces CF Browser Rendering)
- **Lifecycle:** session open → Vercel API finds-or-creates the sandbox (metadata `vibesdk_session={sessionId}`), resumes if paused, rehydrates if dead (create from template, restore files from `agent_state.generatedFilesMap`, `git init` + synthetic initial commit, `bun install`). Idle (no presence and no activity for the idle window; default 10 minutes, env-tunable) → Vercel Cron pauses. `timeoutSeconds` hard cap as leak backstop (default 7 days, the platform max) — acceptable because rehydration rebuilds everything from Postgres. Session JWTs are minted by the Vercel API per sandbox create/resume with a 1-hour expiry; the agent refreshes via a dedicated API endpoint authenticated by the previous token.
- **Deploy sandbox:** as designed in the parked branch: always-on, `bun run preview` (build + serve honoring `PORT`) under `monitor-cli`, replaced on redeploy, killed on app delete. Mapping rows live in `deployments`.
- **Egress:** agent sandboxes get an allowlist (npm/GitHub/AI providers/Supabase project host) and LLM provider keys via `attachSecret` egress injection — raw keys never enter the sandbox.

### 3.4 Security model

- Untrusted generated code runs beside the agent, so the sandbox is treated as semi-hostile even to itself:
  - dev server runs as a separate unix user; agent-owned files (state, sqlite stores) are not world-readable
  - the only credential in the sandbox is a short-lived Supabase JWT scoped by RLS to that session's rows; leaking it exposes one session, not the platform
  - LLM keys: egress-injected, host-allowlisted; a compromised sandbox can spend tokens on allowlisted providers until killed, but cannot exfiltrate the keys
  - platform operations (deploy, sandbox lifecycle, secret management) require the Vercel API
- Preview URLs are capability URLs on per-sandbox origins. Per-app origins are strictly better isolation than today's shared preview domain (no shared-origin service-worker or cookie games), so the old header-stripping proxy is not carried forward.

## 4. What is deleted at cutover

Workers runtime and `worker/index.ts` routing, all Durable Objects (`CodeGeneratorAgent`, `UserSecretsStore`, `DORateLimitStore`, `SpaceDO`/`space` package), D1/KV/R2 bindings, AI Gateway coupling (direct provider SDKs; gateway URL stays configurable), Workers-for-Platforms dispatch, `@cloudflare/sandbox`, `SandboxDockerfile`, the sandbox request-handler proxy, wrangler/miniflare tooling for vibesdk itself.

## 5. Local development

`vite dev` (SPA) + `vercel dev` or a local Hono server (API) + `supabase start` (local Postgres/Auth/Realtime/Storage) + Superserve sandboxes (cloud by default; self-hosted sandbox backend via `SUPERSERVE_BASE_URL` for full-local). No wrangler, no tunnels, no Docker requirements beyond Supabase's.

## 6. Phasing (each phase gets its own spec → plan → build cycle)

1. **Phase 1 — Agent runtime extraction (riskiest first).** Port the agent core to a standalone Bun service that runs in a Superserve sandbox: DO storage → `agent_state`/`agent_messages`, WebSocket broadcast → Supabase Realtime, sandbox service → `LocalSandboxService`, real git, in-sandbox dev server + log/error capture. Deliverable: a full generation session (create → phases → preview URL → errors/logs → static analysis) driven end-to-end against a real sandbox + local Supabase, with the existing frontend message protocol observable on the channel.
2. **Phase 2 — Platform port.** API routes on Vercel (Hono), Supabase Auth + RLS, Drizzle→Postgres migration of existing tables, user secrets on Postgres, rate limiting, template storage. Deliverable: login → create app → session bootstrap works against Phase 1 agents.
3. **Phase 3 — Preview/deploy lifecycle.** Direct-URL previews wired into the frontend, deploy sandboxes + `deployments` rows, redeploy/delete flows, idle-pause cron, rehydration path, egress secret attachment. Deliverable: PRD-equivalent acceptance: live preview with HMR, deployed always-on app on a stable URL.
4. **Phase 4 — Cutover & cleanup.** Data migration script (D1 export → Postgres), docs/runbooks, delete the Cloudflare path, README repositioning ("provider-pluggable, Superserve default").

## 7. Risks & open questions

- **R1 — Agent port surface.** `worker/agents/` is ~90 files built against DO storage and `cloudflare:workers` env. The port is mechanical in principle (storage + env + transport seams) but large; Phase 1's plan must inventory the seams first.
- **R2 — Realtime semantics.** Supabase broadcast ordering/at-most-once vs today's WS: the `agent_messages` seq log + snapshot-on-subscribe covers reconnect, but the Phase 1 plan must verify token-streaming UX at real rates.
- **R3 — Sandbox-per-session cost.** Pause-on-idle plus hard timeout bounds it; needs a real cost model against expected session counts (carried over from old PRD R2).
- **R4 — Custom domains on the Superserve edge.** Branded preview URLs need platform support; raw sandbox URLs are the fallback (accepted).
- **R5 — Supabase Realtime self-host parity.** "Run locally" relies on `supabase start` Realtime matching hosted behavior for private channels/RLS.
- **R6 — Egress secret injection coverage.** Verify every LLM provider endpoint the agent uses is proxyable via Superserve secrets; otherwise those keys fall back to sandbox env (weakens decision 5).
- **R7 — Anonymous sessions.** Mapping today's `sessionToken` anonymous apps onto Supabase anonymous auth needs UX verification (app recovery on login).

## 8. Carried-forward assets from the parked branch

- Superserve backend behavioral facts (verified): data-plane exec default timeout 30s (always pass explicit timeouts); `setsid`-detached processes survive exec; preview edge proxies WebSockets; paused sandboxes → plain-text 503 + `Retry-After: 5`; SDK auto-resume on commands/files.
- `scripts`-style template build via `Template.create` (no Dockerfile upload; steps + readyCmd), sized vcpu 4 / 8 GiB / 10 GiB.
- `container/` harness (ProcessMonitor, bun:sqlite log/error stores) — reused in both sandbox images.
- `staticAnalysisParsers` and bulk-write patterns; `timingSafeEqual` convention for any token comparison.
- Commits `b210416` (SDK dep + config vars) and `6b72823`+`4c72cdf` (HMAC preview tokens) — the token helper becomes unnecessary if no vibesdk proxy survives, but the SDK dependency and config-var plumbing carry forward.
