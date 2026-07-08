# Thin End-to-End Vertical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One clickable end-to-end flow on the re-platformed stack: sign in (Supabase Auth) → create app → agent generates in a Superserve sandbox streaming over Supabase Realtime → live preview iframe. Vercel/Hono API + Supabase + Superserve; NO Cloudflare Workers runtime on this path.

**Architecture:** `worker/app.ts`'s `createApp(env): Hono` is already portable (all Workers coupling is in `worker/index.ts`, which we bypass). Serve it from a Vercel Node function via `@hono/node-server/vercel`. Repurpose `POST /api/agent` to: create the app row (AppService, done in 2a) → insert an `agent_sessions` row → mint a session-scoped Supabase JWT (`session_id` claim) → boot a Superserve agent sandbox (extracted from the Phase-1 boot script) running `agent-runtime/main.ts` → return `{ agentId, sessionId, realtimeChannel, previewUrl }`. Frontend swaps cookie-auth→Supabase-Auth and the native WebSocket→`supabase.channel(...)`, reusing the transport-agnostic message dispatcher verbatim.

**Tech Stack:** Vercel Node serverless, Hono (`@hono/node-server/vercel`), `@supabase/supabase-js` (Realtime + Auth), `jose` (JWT), `@superserve/sdk`, postgres-js/Drizzle (done), React 19 + Vite (SPA static output).

## Global Constraints
- Reuse, don't rebuild: `createApp` (worker/app.ts:14), `AppService.createApp` (worker/database/services/AppService.ts:56), `supabaseAuth.requireUser` (worker/services/auth/supabaseAuth.ts:189), the Phase-1 boot logic (`scripts/superserve/boot-agent-sandbox.ts`) and JWT mint (`scripts/agent-runtime/dev-session.ts:164-172`), the agent runtime (`agent-runtime/`), and the transport-agnostic frontend dispatcher (`src/routes/chat/utils/handle-websocket-message.ts` — reuse VERBATIM).
- Realtime channel contract (fixed, shared by agent + browser + Phase-1): topic `session:{sessionId}`, private; agent→browser event `"message"` (payload = the `worker/api/websocketTypes.ts` JSON), browser→agent event `"client"` (payload `{ raw }` OR the message object — MATCH what `agent-runtime/src/transport.ts` expects: it reads `payload.raw` as the JSON string; the browser sends `{ raw: JSON.stringify({type,...}) }`).
- Session JWT claims (required by the Phase-1 agent_* RLS + Realtime policies, `supabase/migrations/20260707000001_agent_runtime.sql:44-66`): `session_id` (the only table-policy claim), `role:'authenticated'`, `aud:'authenticated'`, `exp` now+3600. Sign HS256 with `SUPABASE_JWT_SECRET` (NEW env var — add it; it is NOT the legacy `JWT_SECRET`).
- The Vercel API's OWN Postgres writes use the service-role / direct `SUPABASE_DB_URL` connection (bypasses RLS, per migration comment). The minted `session_id` JWT is handed to the sandbox agent + the browser client only.
- Env vars (all as plain secrets, following the existing `(env as Record<string,unknown>)[k]` cast pattern — do NOT require regenerating `worker-configuration.d.ts`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `SUPERSERVE_API_KEY`, `SUPERSERVE_AGENT_TEMPLATE` (default `vibesdk-agent`), `SUPERSERVE_BASE_URL?`, `TEMPLATES_BASE_URL`, `CLOUDFLARE_AI_GATEWAY_URL?`/`_TOKEN?`. Frontend: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- No `any`; no emojis; no TODO comments. bun. Keep the standalone agent-runtime green (`bun test agent-runtime` 69 pass) throughout. Root typecheck stays green (it's green as of 2a `e0055bc`) — do NOT regress it; a task that can't keep it green must say why.
- This vertical does NOT run live here (no Docker/hosted Supabase/Superserve template). Deliverables are: type-correct, unit-tested, and a runbook with the exact live-run steps. The live e2e is the user's to run per the runbook.
- Commit per task; conventional commits; push to `personal` main when the vertical is green (Task 10). Pre-existing dirty sandbox files (`worker/services/sandbox/sandboxSdkClient.ts`, `types.ts`, `bulkFileScript.*`) stay untouched.

## File Structure
| Path | Action | Responsibility |
|---|---|---|
| `package.json` | modify | add `@hono/node-server` direct dep |
| `api/[[...route]].ts` | create | Vercel Node catch-all → `handle(createApp(process.env))` |
| `vercel.json` | create | rewrites: `/api/*`→function, else→SPA; env list (docs) |
| `vite.config.ts` | modify | remove `cloudflare()` plugin so `vite build` emits static SPA |
| `worker/app.ts` | modify | make the `notFound`→`env.ASSETS` handler Vercel-safe (no ASSETS on Node) |
| `worker/services/auth/sessionJwt.ts` | create | `mintSessionJwt(sessionId, env)` (jose HS256, the claims) |
| `worker/database/services/AgentSessionService.ts` | create | insert/get `agent_sessions` rows (service-role/direct db) |
| `worker/services/sandbox/agentSandboxBoot.ts` | create | `bootAgentSandbox(opts): Promise<{ sandboxId, previewUrl }>` (extract from the Phase-1 CLI script) |
| `worker/api/controllers/agent/controller.ts` | modify | repurpose `startCodeGeneration` → create-app + boot composition; add `connectToAgent` (session-JWT + channel + previewUrl) |
| `worker/api/routes/codegenRoutes.ts` | modify | keep `POST /api/agent` + a connect endpoint; drop `/ws`, `/db/*` regs |
| `src/lib/supabase.ts` | create | browser Supabase client (VITE_* ) |
| `src/vite-env.d.ts` | modify | type `VITE_SUPABASE_*` |
| `src/contexts/auth-context.tsx` | modify | Supabase Auth (login/email/register/logout/checkAuth); real token |
| `src/routes/chat/hooks/use-chat.ts` | modify | `createAgentSession` JSON response; `new WebSocket`→`supabase.channel`; message listener→`broadcast` |
| `src/routes/chat/utils/websocket-helpers.ts` | modify | send/ready over the channel |
| `src/routes/chat/components/preview-iframe.tsx` | modify | channel type + redeploy send |
| `src/lib/api-client.ts` | modify | `createAgentSession`/`connectToAgent` return the new JSON shape |
| `docs/thin-vertical.md` | create | runbook: build agent template, env, run, manual e2e steps |
| `test/worker/services/**`, `test/worker/api/**` | create | unit tests |

**Shared response contract (Tasks 5 ↔ 9 must agree):**
```ts
interface AgentBootstrapResponse { agentId: string; sessionId: string; realtimeChannel: string; previewUrl: string | null; }
// realtimeChannel === `session:${sessionId}`; agentId === sessionId for the vertical (1:1). previewUrl may be null until the dev server is up (client polls).
```

---

### Task 1: Vercel/Hono serving skeleton + static SPA build
**Files:** create `api/[[...route]].ts`, `vercel.json`; modify `package.json` (dep), `vite.config.ts` (drop cloudflare plugin), `worker/app.ts` (Vercel-safe notFound). Test: `test/worker/api/vercelHandler.test.ts`.
**Interfaces produced:** a Node-served Hono app; `GET /api/health` responds 200 under `@hono/node-server`.

- [ ] **Step 1: dep** — `bun add @hono/node-server` (currently only transitive). Verify version.
- [ ] **Step 2: failing test** — `vercelHandler.test.ts`: import `createApp` (worker/app.ts), build the app with a fake `process.env`-shaped `Env`, `app.request('/api/health')` → 200 with the health JSON. Run → this actually should PASS already if createApp is portable; the REAL test is that createApp doesn't throw under a plain-object env (no cloudflare:workers). If `createApp` imports anything Workers-only at module scope, this surfaces it — fix by moving that import behind the runtime seam. Assert `/api/health` 200.
- [ ] **Step 3: `api/[[...route]].ts`** —
```ts
import { handle } from '@hono/node-server/vercel';
import { createApp } from '../worker/app';
export const config = { runtime: 'nodejs' };
export default handle(createApp(process.env as unknown as Env));
```
- [ ] **Step 4: `worker/app.ts` notFound** — the current `notFound` calls `env.ASSETS.fetch` (Workers-only). Guard it: if `env.ASSETS` is absent (Vercel), return a plain 404 JSON for `/api/*` and let non-API paths 404 (the SPA is served by Vercel static, not the app). Behavior on Workers unchanged (ASSETS present).
- [ ] **Step 5: `vite.config.ts`** — remove the `cloudflare({configPath})` plugin so `vite build` emits a static SPA to `dist/`. Keep react/svgr/tailwind + aliases. (This means `wrangler dev` no longer serves the app — acceptable; big-bang.)
- [ ] **Step 6: `vercel.json`** — `{ "rewrites": [{ "source": "/api/(.*)", "destination": "/api" }, { "source": "/(.*)", "destination": "/index.html" }] }` plus a comment listing required env vars. Verify `bunx vercel build` is NOT run here (no Vercel auth); just the config + `vite build` producing `dist/` (run `bun run build`'s vite step if feasible, or typecheck only).
- [ ] **Step 7: verify** — the test passes; `bun run typecheck` green; `bun test agent-runtime` 69 pass. Commit `feat: vercel node/hono serving skeleton + static SPA build`.

---

### Task 2: Session JWT mint module
**Files:** create `worker/services/auth/sessionJwt.ts`; test `test/worker/services/auth/sessionJwt.test.ts`.
**Interfaces produced:** `mintSessionJwt(sessionId: string, env: Env): Promise<string>` — HS256, claims `{ session_id, role:'authenticated' }`, `aud:'authenticated'`, `iat`, `exp` now+3600, signed with `SUPABASE_JWT_SECRET`.
- [ ] Extract verbatim from `scripts/agent-runtime/dev-session.ts:164-172` (jose `SignJWT`), reading `SUPABASE_JWT_SECRET` via the env-cast pattern (`(env as unknown as Record<string,string>).SUPABASE_JWT_SECRET`), throw a clear error if absent.
- [ ] Test: decode the minted JWT (jose `jwtVerify` with the same secret) → assert `session_id`, `role`, `aud`, and `exp>now` present; wrong-secret verify throws. Write test first (RED), implement (GREEN).
- [ ] Verify + commit `feat: session JWT mint for agent sandbox + realtime`.

---

### Task 3: AgentSessionService
**Files:** create `worker/database/services/AgentSessionService.ts`; test.
**Interfaces produced:** `createAgentSession(db, { sessionId, agentId, userId, initArgs })`, `getAgentSession(db, sessionId)`, `updateSandboxId(db, sessionId, sandboxId)` over the `agent_sessions` table (columns per `supabase/migrations/20260707000001_agent_runtime.sql:2-11`: session_id, agent_id, user_id, status, init_args, sandbox_id, timestamps).
- [ ] Model on `AppService` (BaseService `this.database` db). Insert with `status:'provisioning'`. Fake-drizzle recorder test (Task-5-of-2a pattern) asserting the right table/columns; RED→GREEN.
- [ ] Verify + commit `feat: agent session service (agent_sessions table)`.

---

### Task 4: Superserve boot module (importable)
**Files:** create `worker/services/sandbox/agentSandboxBoot.ts`; test.
**Interfaces produced:** `bootAgentSandbox(opts: { sessionId, agentId, sessionJwt, env, api? }): Promise<{ sandboxId: string; previewUrl: string }>` — `Sandbox.create({...})` + detached `commands.run("cd /opt/vibesdk && setsid nohup bun agent-runtime/src/main.ts > /workspace/agent.log 2>&1 < /dev/null & echo $!", {timeoutMs:15000})` + `sandbox.getPreviewUrl(8080)`. Drop the CLI tail-follow. Injectable `api` (the `@superserve/sdk` `Sandbox` surface) for testing.
- [ ] Extract from `scripts/superserve/boot-agent-sandbox.ts:112-180`. envVars passed to the sandbox = the agent's `parseBootstrapEnv` contract (SESSION_ID, AGENT_ID, WORKSPACE_DIR='/workspace', SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SESSION_JWT=the minted JWT, TEMPLATES_BASE_URL, optional gateway). `fromTemplate` = `env.SUPERSERVE_AGENT_TEMPLATE ?? 'vibesdk-agent'` (RECONCILE: `worker-configuration.d.ts:61` calls it `SUPERSERVE_TEMPLATE`='vibesdk-sandbox' which is the deploy template; the AGENT template is `vibesdk-agent` — use a distinct `SUPERSERVE_AGENT_TEMPLATE` var, document in the runbook). network.allowOut = derive supabase host + npm/github/AI hosts.
- [ ] Test with an injected fake `Sandbox` api: assert create options (name, fromTemplate, envVars incl. the JWT + session id, metadata `vibesdk_kind:'agent'`), the detached run command shape (`setsid nohup ... & echo $!`), and returns `{sandboxId, previewUrl}`. RED→GREEN. (No live Superserve.)
- [ ] Verify + commit `feat: importable superserve agent-sandbox boot module`.

---

### Task 5: Repurpose POST /api/agent → create-app + boot
**Files:** modify `worker/api/controllers/agent/controller.ts` (`startCodeGeneration`), `worker/api/routes/codegenRoutes.ts`. Test `test/worker/api/agentBootstrap.test.ts`.
**Interfaces produced:** `POST /api/agent` returns `AgentBootstrapResponse` (JSON, not NDJSON). Consumed by Task 9.
- [ ] Rewrite `startCodeGeneration`: `requireUser(env, request)` → validate `query` → `agentId = sessionId = generateId()` → `AppService.createApp({ id: agentId, userId, title: query.slice(0,100), originalPrompt: query, status:'generating', ... })` → `AgentSessionService.createAgentSession(db, { sessionId, agentId, userId, initArgs:{ query, projectType, behaviorType } })` → `jwt = mintSessionJwt(sessionId, env)` → `bootAgentSandbox({ sessionId, agentId, sessionJwt: jwt, env })` → `updateSandboxId` → return `{ agentId, sessionId, realtimeChannel: \`session:${sessionId}\`, previewUrl }`. Strip the DO/NDJSON path, the BYOK/usage-limit/model-config machinery (agent gets keys via Superserve egress). On boot failure, mark the app `status:'generating'`-failed and return a 502 with a clear error.
- [ ] `codegenRoutes.ts`: keep `POST /api/agent`; DELETE `/ws`, `/connect` (old), `/db/*`, `/preview` (old DO) registrations (Realtime replaces; connect endpoint added in Task 6).
- [ ] Test with fakes for AppService/AgentSessionService/mint/boot (inject via the controller's service construction or module seams): assert the composition calls each in order and returns the right shape; auth-required (no user → 401). RED→GREEN.
- [ ] Verify (`bun run typecheck` green; agent-runtime 69) + commit `feat: repurpose POST /api/agent to create app + boot superserve agent sandbox`.

---

### Task 6: agent-connect + preview-url endpoint
**Files:** modify `worker/api/controllers/agent/controller.ts` (add `connectToAgent`), `codegenRoutes.ts`. Test.
**Interfaces produced:** `GET /api/agent/:id/connect` → `{ agentId, sessionId, realtimeChannel, token, previewUrl }` — for an EXISTING app: `requireUser` (owner check via the app row) → look up `agent_sessions` → re-mint the session JWT → resolve previewUrl (from `sandbox_id` via `Sandbox.getPreviewUrl` or a stored value). This is what the frontend calls to reconnect.
- [ ] Owner check: the app's `userId === user.id`. Re-mint JWT (short-lived; the browser uses it to join the Realtime channel — NOTE: the browser client joining `session:{id}` needs this session JWT; document that the browser uses the session token for the channel, and the user's own Supabase token for other API calls).
- [ ] Test: existing app + owner → returns channel+token+previewUrl; non-owner → 403; missing → 404. RED→GREEN.
- [ ] Verify + commit `feat: agent connect endpoint (realtime channel + session token + preview url)`.

---

### Task 7: Frontend Supabase client
**Files:** create `src/lib/supabase.ts`; modify `src/vite-env.d.ts`. Test (optional — pure client construction).
**Interfaces produced:** `export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })`.
- [ ] Add `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` to a typed `ImportMetaEnv` in `vite-env.d.ts`. Add both to `.dev.vars.example` / a `.env.example`.
- [ ] Verify `bun run typecheck` green. Commit `feat: frontend supabase client`.

---

### Task 8: Auth-context Supabase swap
**Files:** modify `src/contexts/auth-context.tsx`.
**Interfaces produced:** the SAME `AuthContextType` (UI/ProtectedRoute unchanged), backed by Supabase.
- [ ] `login(provider)` → `supabase.auth.signInWithOAuth({ provider, options:{ redirectTo } })`; `loginWithEmail`→`signInWithPassword`; `register`→`signUp`; `logout`→`signOut`. Replace `checkAuth` (:141) with `supabase.auth.getSession()` on mount + `supabase.auth.onAuthStateChange((_e, session) => { setUser(mapUser(session?.user)); setToken(session?.access_token ?? null); })`. Populate the real `token` (currently hard-null at :148/:215/:253). `mapUser` maps a Supabase user → the app's `user` shape (id, email, displayName from user_metadata). Drop/stub `authProviders`/`fetchAuthProviders`.
- [ ] Verify `bun run typecheck` green (the context's consumers compile). No unit test framework for React context here is set up simply — rely on typecheck + the manual e2e in the runbook; if a light test is cheap (render the provider with a fake supabase), add it. Commit `feat: supabase auth in auth-context`.

---

### Task 9: Frontend transport swap (WebSocket → Realtime) + create-app response
**Files:** modify `src/routes/chat/hooks/use-chat.ts`, `src/routes/chat/utils/websocket-helpers.ts`, `src/routes/chat/components/preview-iframe.tsx`, `src/lib/api-client.ts`.
**Interfaces consumed:** the Task-5 `AgentBootstrapResponse` JSON + the Task-6 connect JSON.
- [ ] `api-client.ts`: `createAgentSession` now POSTs `/api/agent` and returns parsed JSON `AgentBootstrapResponse` (not a raw NDJSON stream); `connectToAgent` returns the connect JSON. Remove the `skipJsonParsing`/stream handling.
- [ ] `use-chat.ts` `init()` (:478-660): for new app, `const r = await apiClient.createAgentSession(args)` → `r.agentId`, `r.realtimeChannel`, `r.previewUrl`; set previewUrl; open the channel via a new `connectChannel(realtimeChannel, sessionToken)` instead of `connectWithRetry(websocketUrl)`. Get the session token: for a NEW app the create response should also include the browser's session token (add `token` to `AgentBootstrapResponse` in Task 5 — the browser needs it to join the private channel), OR the browser calls `connectToAgent` to get it. SIMPLEST: include `token` in both responses. `supabase.realtime.setAuth(token)` then `supabase.channel(realtimeChannel, { config:{ broadcast:{self:false}, private:true } })`, `.on('broadcast', {event:'message'}, ({payload}) => handleWebSocketMessage(channelShim, payload))`, `.subscribe()`. On SUBSCRIBED for a new chat, send `generate_all`.
- [ ] `websocket-helpers.ts`: `sendWebSocketMessage(channel, type, data)` → `channel.send({ type:'broadcast', event:'client', payload:{ raw: JSON.stringify({ type, ...data }) } })`; `isWebSocketReady` → channel-state check. Keep the same exported signatures so callers are unchanged (pass the channel where `ws` was).
- [ ] `preview-iframe.tsx`: replace the `partysocket` `WebSocket` type import + `.readyState`/`OPEN` + the redeploy `webSocket.send({type:'preview'})` with the channel-send equivalent. Keep the HEAD-poll + iframe markup.
- [ ] The `handle-websocket-message.ts` dispatcher is UNCHANGED (transport-agnostic) — pass a small `channelShim` object exposing `.send(str)` (mapping to the channel broadcast) so the handler's `sendMessage`/`websocket.send` calls work verbatim.
- [ ] Verify `bun run typecheck` green. Commit `feat: frontend transport over supabase realtime`.

---

### Task 10: Wire-up, runbook, verification sweep, push
**Files:** create `docs/thin-vertical.md`; modify `.dev.vars.example`. 
- [ ] Gates: `bun run typecheck` GREEN, `bun run typecheck:agent-runtime` 0, `bun test agent-runtime` 69, `bun run test` (worker unit) green, `bun run lint` (report pre-existing). `bun run build` (vite static SPA emits `dist/`) — if it needs the removed cloudflare plugin, reconcile.
- [ ] `docs/thin-vertical.md` runbook: (1) build the `vibesdk-agent` Superserve template (`SUPERSERVE_API_KEY=... bun run scripts/superserve/build-agent-template.ts` — note SUPERSERVE_AGENT_TEMPLATE name), (2) a hosted Supabase project + `bunx supabase db push` both migrations, (3) env vars (API + VITE), (4) run: `vercel dev` (or `@hono/node-server` local + `vite dev`), (5) manual e2e: sign in → enter a prompt → watch generation stream → preview loads. (6) the deferred live verifications (this is where the whole stack first runs for real).
- [ ] Commit `chore: thin vertical runbook + verification sweep`. Then push: `git push personal HEAD:main`.

## Self-Review Notes (applied)
- The `token` field must be in BOTH `AgentBootstrapResponse` (Task 5) and the connect response (Task 6) — the browser needs the session JWT to join the private `session:{id}` channel. Added to the contract; Task 9 consumes it. (Type consistency across 5/6/9.)
- `realtimeChannel`/`sessionId`/`agentId` names consistent across Tasks 5/6/9.
- Reused-verbatim: `handle-websocket-message.ts` dispatcher (via channelShim), `createApp`, `AppService`, `requireUser`, the Phase-1 boot/JWT logic (extracted, not rewritten), the agent runtime.
- The vertical does NOT run live in this env (no Docker/hosted Supabase/Superserve template) — the gate is typecheck + unit tests + the runbook; the live e2e is explicitly the user's step (documented). This is the honest scope, matching the Phase-1/2a deferred-live-verification pattern.
- Placeholder scan: the two React tasks (8/9) rely on typecheck + manual-e2e rather than unit tests where a test harness isn't cheaply available — flagged, not hidden; the backend tasks (1-6) are unit-tested.
- SUPERSERVE_AGENT_TEMPLATE vs SUPERSERVE_TEMPLATE naming reconciled (distinct vars: agent vs deploy/preview template) + documented.

## Execution
Subagent-driven, task-by-task, review each. Tasks 5↔9 share the response contract (defined above) — reviewer checks both agree. Backend (1-6) first, then frontend (7-9), then wire-up/runbook/push (10). Keep root typecheck + agent-runtime green at every gate.
