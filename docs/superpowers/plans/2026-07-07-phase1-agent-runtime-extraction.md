# Phase 1: Agent Runtime Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run vibesdk's per-session code-generation agent as a standalone Bun process (bootable inside a Superserve sandbox) with state in Supabase Postgres, browser transport over Supabase Realtime, and sandbox operations executed locally — while the existing Cloudflare Workers build stays green.

**Architecture:** No fork. The agent tree (`worker/agents/`, ~130 files) already depends on two interfaces — `AgentInfrastructure<TState>` (worker/agents/core/AgentCore.ts:17-46: `state`, `setState`, `broadcast`, `getWebSockets`, `env`, conversation methods, `fileManager`/`deploymentManager`/`git`) and `ICodingAgent` (services/interfaces/ICodingAgent.ts, ~30 delegating methods). Only ~5 files import Workers-only modules directly. We make those seams injectable **in place** (runtime-env holder, type-only `agents` imports, injectable git fs, template source, sandbox-factory override), then add a new workspace package `agent-runtime/` containing a `StandaloneAgent` that implements the same interfaces backed by Postgres + Realtime + local filesystem, and reuses behaviors/operations/tools untouched. `worker/agents/core/codingAgent.ts` (the Durable Object class) is never imported by the new package.

**Tech Stack:** Bun (runtime + `bun test`), `@supabase/supabase-js` v2 (Realtime private channels + PostgREST), existing `openai` SDK through an AI-gateway URL (`CLOUDFLARE_AI_GATEWAY_URL` path already exists in inferutils — no `env.AI` binding needed), isomorphic-git over real `node:fs`, `container/` ProcessMonitor as an in-process library.

## Global Constraints

- The Cloudflare Workers build must stay green after every task: `bun run typecheck && bun run test` (root vitest, workers pool) — in-place seam edits are behavior-preserving for the Workers path.
- `agent-runtime/` is tested with `bun test agent-runtime` only; it must be excluded from the root vitest include set (workers pool cannot load `node:fs`/`bun:sqlite` code).
- Message protocol identity: all broadcasts keep the exact `websocketTypes.ts` message `type` strings and payload shapes (57 types; `agent_connected` carries `{ state, templateDetails, previewUrl? }`).
- Realtime channel name: `session:{sessionId}`, private channel; agent→browser broadcast event `"message"`, browser→agent event `"client"`. Payloads are the JSON messages, not re-wrapped.
- Postgres tables (created in Task 5, exact names): `agent_sessions`, `agent_state`, `agent_messages`, `agent_conversations`.
- No `any` (repo rule). No emojis. Conventional commits, no co-author lines. Do not run `wrangler`, the frontend dev server, or deploy anything.
- Env names for the Bun process (Task 6/10): `SESSION_ID`, `AGENT_ID`, `WORKSPACE_DIR`, `SUPABASE_URL`, `SUPABASE_SESSION_JWT`, `TEMPLATES_BASE_URL`, `CLOUDFLARE_AI_GATEWAY_URL`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, `SELF_PREVIEW_BASE_URL` (optional), plus provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY`, `OPENROUTER_API_KEY`) when not using the gateway.
- Integration-gated tests: anything needing `supabase start` runs only when `SUPABASE_LOCAL=1`; anything needing a Superserve account only via manual scripts (never in CI/test suites).
- Out of Phase 1 scope (interface-preserving stubs with explicit "unsupported in standalone runtime" errors, no TODO comments): `think` behavior (`@cloudflare/think`, `RpcTarget`, `SPACE_DO`, `THINK_DO`), user-secrets vault (`UserSecretsStore` DO), screenshot capture (`@cloudflare/puppeteer`), GitHub export, `deployToCloudflare` (Phase 3), D1 `AppService` side-writes (logged and skipped via a seam).

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `worker/utils/runtimeEnv.ts` | create | process-global Env holder: `setRuntimeEnv`/`getRuntimeEnv` |
| `worker/index.ts`, `test/worker-entry.ts` | modify | call `setRuntimeEnv(env)` at module scope |
| `worker/agents/inferutils/config.ts`, `worker/agents/tools/toolkit/web-search.ts`, `worker/agents/tools/toolkit/feedback.ts` | modify | swap `import { env } from 'cloudflare:workers'` → `getRuntimeEnv()` |
| `worker/agents/core/websocket.ts`, `worker/agents/core/behaviors/base.ts` | modify | type-only `agents` imports; handler retyped to `AgentHost` interface |
| `worker/agents/git/*` | modify | export the fs interface; make `GitVersionControl` fs injectable |
| `worker/services/sandbox/templateSource.ts` | create | template catalog seam: R2 impl (Workers) + HTTP impl (Bun) |
| `worker/services/sandbox/BaseSandboxService.ts` | modify | statics delegate to templateSource |
| `worker/services/sandbox/factory.ts` | modify | `setSandboxServiceFactory()` override hook |
| `supabase/config.toml`, `supabase/migrations/20260707000001_agent_runtime.sql` | create | local stack + schema + RLS + realtime policies |
| `agent-runtime/package.json`, `agent-runtime/tsconfig.json` | create | new workspace package (bun test) |
| `agent-runtime/src/envAdapter.ts` | create | `Env`-shaped adapter over `process.env` with throwing binding proxies |
| `agent-runtime/src/stateStore.ts` | create | debounced Postgres state persistence |
| `agent-runtime/src/conversationStore.ts` | create | conversation persistence over PostgREST |
| `agent-runtime/src/transport.ts` | create | Realtime channel: broadcast out, client messages in, connection shim |
| `agent-runtime/src/localSandbox.ts` | create | `BaseSandboxService` over local fs/exec/ProcessMonitor |
| `agent-runtime/src/standaloneAgent.ts` | create | `AgentInfrastructure` + `ICodingAgent` implementation |
| `agent-runtime/src/main.ts` | create | bootstrap entrypoint |
| `agent-runtime/test/*.test.ts` | create | bun tests per module |
| `scripts/agent-runtime/dev-session.ts` | create | local e2e smoke driver |
| `scripts/superserve/build-agent-template.ts`, `scripts/superserve/boot-agent-sandbox.ts` | create | staging-gated sandbox template + boot |
| `docs/agent-runtime.md` | create | runbook |

Note on pre-existing untracked files: the working tree may contain uncommitted `worker/services/sandbox/{bulkFileScript,staticAnalysisParsers}.ts` (+tests) from a killed earlier task. Task 8 adopts `staticAnalysisParsers` if present (verify content compiles and tests pass before committing); `bulkFileScript` is NOT needed in this phase — leave it untracked and untouched.

---

### Task 1: `agent-runtime` package scaffold

**Files:**
- Create: `agent-runtime/package.json`, `agent-runtime/tsconfig.json`, `agent-runtime/src/index.ts`, `agent-runtime/test/scaffold.test.ts`
- Modify: root `package.json` (workspaces + script), root `vitest.config.ts` (exclude)

**Interfaces:**
- Produces: workspace package `@vibesdk/agent-runtime`; root script `"test:agent-runtime": "bun test agent-runtime"`; path aliases `worker/*`, `shared/*` resolving from inside the package.

- [ ] **Step 1: Create `agent-runtime/package.json`**

```json
{
  "name": "@vibesdk/agent-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.49.0",
    "isomorphic-git": "*",
    "openai": "*",
    "zod": "*"
  }
}
```

(`"*"` reuses the hoisted root versions; check the root `package.json` has `isomorphic-git` — if the agent git layer imports it, it is there; if the exact dependency name differs, match it.)

- [ ] **Step 2: Create `agent-runtime/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun-types"],
    "baseUrl": "..",
    "paths": {
      "worker/*": ["./worker/*"],
      "shared/*": ["./shared/*"]
    }
  },
  "include": ["src", "test", "../worker/agents", "../worker/services", "../worker/utils", "../worker/types", "../worker/api/websocketTypes.ts", "../shared"]
}
```

If `bun-types` is not installed at root, add it to `agent-runtime/package.json` devDependencies (`"bun-types": "^1.1.0"`). This tsconfig will NOT typecheck cleanly until the seam tasks land — that is expected; Task 1 only requires `bun test` to run. Do not wire `agent-runtime/typecheck` into the root `typecheck` script until Task 10.

- [ ] **Step 3: Create trivial source + test**

```ts
// agent-runtime/src/index.ts
export const AGENT_RUNTIME_VERSION = '0.1.0';
```

```ts
// agent-runtime/test/scaffold.test.ts
import { describe, expect, it } from 'bun:test';
import { AGENT_RUNTIME_VERSION } from '../src/index';

describe('scaffold', () => {
    it('package resolves and runs under bun test', () => {
        expect(AGENT_RUNTIME_VERSION).toBe('0.1.0');
    });
});
```

- [ ] **Step 4: Wire the workspace**

In root `package.json`: `"workspaces": ["space"]` → `"workspaces": ["space", "agent-runtime"]`, and add script `"test:agent-runtime": "bun test agent-runtime"`.
In root `vitest.config.ts`: add `'**/agent-runtime/**'` to the `exclude` array.
Run: `bun install`

- [ ] **Step 5: Verify**

Run: `bun test agent-runtime`
Expected: 1 pass.
Run: `bun run typecheck && bun run test`
Expected: green (root untouched apart from config).

- [ ] **Step 6: Commit**

```bash
git add agent-runtime package.json bun.lock vitest.config.ts
git commit -m "feat: scaffold agent-runtime bun workspace package"
```

---

### Task 2: Runtime env seam (in place)

**Files:**
- Create: `worker/utils/runtimeEnv.ts`
- Modify: `worker/index.ts` (module scope, right after its imports), `test/worker-entry.ts` (same), `worker/agents/inferutils/config.ts:10`, `worker/agents/tools/toolkit/web-search.ts:1`, `worker/agents/tools/toolkit/feedback.ts:2`
- Test: `test/worker/utils/runtimeEnv.test.ts`

**Interfaces:**
- Produces: `setRuntimeEnv(e: Env): void`, `getRuntimeEnv(): Env` (throws `"Runtime env not initialized — call setRuntimeEnv() at process bootstrap"` when unset). Consumed by Tasks 6/9/10 and by the three modified agent files.

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/utils/runtimeEnv.test.ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getRuntimeEnv, setRuntimeEnv } from 'worker/utils/runtimeEnv';

describe('runtimeEnv', () => {
    it('returns the env set at bootstrap', () => {
        setRuntimeEnv(env as never);
        expect(getRuntimeEnv()).toBe(env);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `bun run test -- test/worker/utils/runtimeEnv.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// worker/utils/runtimeEnv.ts
/**
 * Process-global Env holder so agent code can run both on Workers (set from
 * `cloudflare:workers` at entry) and in the standalone Bun runtime (set from
 * an adapter over process.env). Direct `import { env } from
 * 'cloudflare:workers'` is unresolvable under Bun, so agent-tree modules must
 * read env through this seam instead.
 */
let runtimeEnv: Env | undefined;

export function setRuntimeEnv(e: Env): void {
    runtimeEnv = e;
}

export function getRuntimeEnv(): Env {
    if (!runtimeEnv) {
        throw new Error('Runtime env not initialized — call setRuntimeEnv() at process bootstrap');
    }
    return runtimeEnv;
}
```

- [ ] **Step 4: Set at both Workers entries**

In `worker/index.ts`, immediately after the existing imports (it already imports `env`-typed handlers; add):

```ts
import { env as workerGlobalEnv } from 'cloudflare:workers';
import { setRuntimeEnv } from './utils/runtimeEnv';
setRuntimeEnv(workerGlobalEnv);
```

In `test/worker-entry.ts`, add the same three lines (adjust the relative import path to `../worker/utils/runtimeEnv`). If `worker/index.ts` already imports `env` from `cloudflare:workers` under another name, reuse it instead of adding a second import.

- [ ] **Step 5: Swap the three agent-tree import sites**

For each of `worker/agents/inferutils/config.ts:10`, `worker/agents/tools/toolkit/web-search.ts:1`, `worker/agents/tools/toolkit/feedback.ts:2`:

Before: `import { env } from 'cloudflare:workers'`
After: `import { getRuntimeEnv } from 'worker/utils/runtimeEnv';` and at the top of each function/expression that used `env`, add `const env = getRuntimeEnv();`. For module-scope `env.X` reads (config.ts may compute config at module scope), convert the module-scope constant into a lazily-evaluated function or move the read inside the consuming function — behavior must be identical at call time. Compile-check drives completeness: after the import swap, `bun run typecheck` reports every remaining bare `env` use; fix each with the local `const env = getRuntimeEnv();` pattern.

- [ ] **Step 6: Verify Workers path is green**

Run: `bun run typecheck && bun run test`
Expected: all green (the pool entry sets the env before any agent module executes).

- [ ] **Step 7: Commit**

```bash
git add worker/utils/runtimeEnv.ts worker/index.ts test/worker-entry.ts worker/agents/inferutils/config.ts worker/agents/tools/toolkit/web-search.ts worker/agents/tools/toolkit/feedback.ts test/worker/utils/runtimeEnv.test.ts
git commit -m "refactor: route agent env access through runtimeEnv seam"
```

---

### Task 3: Portable websocket handler + type-only `agents` imports (in place)

**Files:**
- Modify: `worker/agents/core/websocket.ts`, `worker/agents/core/behaviors/base.ts`
- Test: existing suite (behavior-preserving retype; no new runtime behavior)

**Interfaces:**
- Produces: `export type AgentHost` in `websocket.ts` — the exact structural surface the handler needs; `handleWebSocketMessage(agent: AgentHost, connection: ConnectionLike, message: string)`, `broadcastToConnections(agent: Pick<AgentHost, 'getWebSockets'>, type, data)`, and `export interface ConnectionLike { id: string; send(data: string): void; url?: string | null }`. Task 10's `StandaloneAgent` implements `AgentHost`; Task 7's transport provides `ConnectionLike`.

- [ ] **Step 1: Make `agents` imports type-only**

In `worker/agents/core/websocket.ts:1` and `worker/agents/core/behaviors/base.ts:1`: `import { Connection } from 'agents'` → `import type { Connection } from 'agents'`. If either file uses a runtime value from `agents` (not just types), STOP and report — the research says they do not.

- [ ] **Step 2: Introduce `ConnectionLike` and `AgentHost`**

In `websocket.ts`, add:

```ts
/** Minimal connection surface the handler uses (satisfied by agents-SDK Connection and by the standalone Realtime shim). */
export interface ConnectionLike {
    id: string;
    send(data: string): void;
    url?: string | null;
}
```

Replace the handler's `agent: CodeGeneratorAgent` parameter type with a structural type derived from what the file actually calls. Start from this and let the compiler complete it:

```ts
import type { AgentInfrastructure } from './AgentCore';
import type { ICodingAgent } from '../services/interfaces/ICodingAgent';
import type { AgentState } from './state';

/** Structural surface of the agent as seen by the message handler — implemented by CodeGeneratorAgent (Workers) and StandaloneAgent (Bun). */
export type AgentHost = AgentInfrastructure<AgentState> & ICodingAgent;
```

Then change `handleWebSocketMessage(agent: CodeGeneratorAgent, connection: Connection, message: string)` → `(agent: AgentHost, connection: ConnectionLike, message: string)`, and `broadcastToConnections`'s parameter to `Pick<AgentHost, 'getWebSockets'>` (keep its current body). Run `bun run typecheck`: every member the handler calls that is missing from `AgentInfrastructure & ICodingAgent` (e.g. `handleUserInput`, model-config or vault helpers) gets added to `AgentHost` as an explicit intersection member with its exact signature copied from `codingAgent.ts`:

```ts
export type AgentHost = AgentInfrastructure<AgentState> & ICodingAgent & {
    handleUserInput(message: string, images?: ProcessedImageAttachment[]): Promise<void>;
    // ...add each member typecheck demands, copied verbatim from codingAgent.ts
};
```

If `AgentState` generics resist (`AgentInfrastructure<BaseProjectState>` vs behavior-specific states), use the same type parameter `codingAgent.ts` binds. `CodeGeneratorAgent` must satisfy `AgentHost` with zero changes to `codingAgent.ts` — if it does not, the intersection is wrong; fix the intersection, not the class.

- [ ] **Step 3: Verify** — `bun run typecheck && bun run test` → green.

- [ ] **Step 4: Commit**

```bash
git add worker/agents/core/websocket.ts worker/agents/core/behaviors/base.ts
git commit -m "refactor: retype websocket handler to structural AgentHost seam"
```

---

### Task 4: Injectable git filesystem (in place)

**Files:**
- Modify: `worker/agents/git/fs-adapter.ts` (export the fs interface type), `worker/agents/git/index.ts` (or wherever `GitVersionControl` constructs `SqliteFS` — locate with `rg -n "new SqliteFS" worker/agents/git`)
- Test: `test/worker/agents/git/injectableFs.test.ts`

**Interfaces:**
- Produces: `export type GitFsPromises` (the promise-API subset `SqliteFS` implements: `readFile`, `writeFile`, `unlink`, `mkdir`, `readdir`, `stat`, `rmdir`, plus any others `fs-adapter.ts` defines — copy the exact member list from the class), and `GitVersionControl` accepting an optional fs override: `constructor(sql: SqlExecutor, options?: { fs?: GitFsPromises })` (match the real current constructor signature — read it first; the shape to preserve is "default = SqliteFS(sql), override wins").
- Consumed by: Task 10 (StandaloneAgent passes a `node:fs/promises`-backed adapter).

- [ ] **Step 1: Read the current wiring**

Run: `rg -n "class GitVersionControl|constructor|new SqliteFS" worker/agents/git/*.ts | head -20`
Identify the constructor and the exact `SqliteFS` instantiation point.

- [ ] **Step 2: Write the failing test**

```ts
// test/worker/agents/git/injectableFs.test.ts
import { describe, expect, it } from 'vitest';
import { GitVersionControl } from 'worker/agents/git';

describe('GitVersionControl fs injection', () => {
    it('uses an injected fs instead of SqliteFS', async () => {
        const calls: string[] = [];
        const files = new Map<string, Uint8Array>();
        const fakeFs = {
            promises: {
                readFile: async (p: string) => {
                    calls.push(`read:${p}`);
                    const hit = files.get(p);
                    if (!hit) { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; }
                    return hit;
                },
                writeFile: async (p: string, d: Uint8Array | string) => {
                    calls.push(`write:${p}`);
                    files.set(p, typeof d === 'string' ? new TextEncoder().encode(d) : d);
                },
                unlink: async (p: string) => { files.delete(p); },
                mkdir: async (_p: string) => undefined,
                readdir: async (_p: string) => [] as string[],
                stat: async (p: string) => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; },
                lstat: async (p: string) => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; },
                rmdir: async (_p: string) => undefined,
            },
        };
        const git = new GitVersionControl(null as never, { fs: fakeFs as never });
        expect(git).toBeDefined();
        // Construction must not touch SqliteFS (sql=null would throw if it did).
    });
});
```

Adapt the fake's shape to the real `GitFsPromises` interface exported in Step 3 — the goal of the test is: with an injected fs, `SqliteFS` is never constructed (passing `sql: null` proves it) and construction succeeds. If `GitVersionControl`'s constructor eagerly runs git ops, follow what it needs; keep the test focused on "override wins, SqliteFS untouched".

- [ ] **Step 3: Implement**

In `fs-adapter.ts`, derive and export the interface from the class (do not hand-write a divergent copy):

```ts
export type GitFsPromises = Pick<SqliteFS, 'readFile' | 'writeFile' | 'unlink' | 'mkdir' | 'readdir' | 'stat' | 'rmdir' /* + exactly the members SqliteFS exposes and isomorphic-git uses */>;
```

In the `GitVersionControl` construction site, add the optional `{ fs?: ... }` parameter; default to the current `SqliteFS` path when absent. Note: isomorphic-git expects an object like `{ promises: {...} }` — match however the current code hands `SqliteFS` to isomorphic-git (it may wrap it; preserve the same wrapping for the injected fs).

- [ ] **Step 4: Verify** — targeted test passes; `bun run typecheck && bun run test` green.

- [ ] **Step 5: Commit**

```bash
git add worker/agents/git test/worker/agents/git/injectableFs.test.ts
git commit -m "refactor: make GitVersionControl filesystem injectable"
```

---

### Task 5: Supabase local stack + agent schema

**Files:**
- Create: `supabase/config.toml` (via `bunx supabase init` — accept defaults, keep generated file), `supabase/migrations/20260707000001_agent_runtime.sql`
- Create: `agent-runtime/test/schema.integration.test.ts` (gated on `SUPABASE_LOCAL=1`)
- Modify: `docs/agent-runtime.md` is written in Task 13; this task documents nothing extra.

**Interfaces:**
- Produces (exact table/column names used by Tasks 6/7/10/11):
  - `agent_sessions(session_id text pk, agent_id text not null, user_id uuid, status text not null default 'provisioning', init_args jsonb, sandbox_id text, last_activity_at timestamptz default now(), created_at timestamptz default now())`
  - `agent_state(session_id text pk references agent_sessions, state jsonb not null, updated_at timestamptz default now())`
  - `agent_messages(id bigint generated always as identity pk, session_id text references agent_sessions, seq bigint not null, payload jsonb not null, created_at timestamptz default now(), unique(session_id, seq))`
  - `agent_conversations(session_id text references agent_sessions, kind text not null check (kind in ('full','compact')), idx bigint not null, message jsonb not null, primary key (session_id, kind, idx))`
  - JWT contract: session-scoped tokens carry claim `session_id`; RLS grants row access where `session_id = (auth.jwt() ->> 'session_id')`; realtime topic `session:{session_id}` readable/writable under the same claim.

- [ ] **Step 1: Initialize supabase project files**

Run: `bunx supabase init` (creates `supabase/config.toml`). Do NOT run `supabase start` in this task unless verifying locally with `SUPABASE_LOCAL=1`.

- [ ] **Step 2: Write the migration**

```sql
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
```

- [ ] **Step 3: Write the gated integration test**

```ts
// agent-runtime/test/schema.integration.test.ts
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
```

- [ ] **Step 4: Verify**

Run: `bun test agent-runtime` → gated tests skip by default, suite green.
Optionally (if Docker available): `bunx supabase start && bunx supabase db reset`, then `SUPABASE_LOCAL=1 SUPABASE_SERVICE_ROLE_KEY=$(bunx supabase status -o json | jq -r '.SERVICE_ROLE_KEY // .service_role_key') bun test agent-runtime/test/schema.integration.test.ts` → 2 pass. If the status JSON keys differ, read `bunx supabase status` output and export manually. Note the result either way in your report.

- [ ] **Step 5: Commit**

```bash
git add supabase agent-runtime/test/schema.integration.test.ts
git commit -m "feat: supabase schema, RLS, and realtime policies for agent runtime"
```

---

### Task 6: Env adapter + state store + conversation store

**Files:**
- Create: `agent-runtime/src/envAdapter.ts`, `agent-runtime/src/stateStore.ts`, `agent-runtime/src/conversationStore.ts`
- Test: `agent-runtime/test/envAdapter.test.ts`, `agent-runtime/test/stateStore.test.ts`

**Interfaces:**
- Produces:
  - `buildEnvAdapter(source?: Record<string, string | undefined>): Env` — string vars copied from `process.env`; every binding the agent tree must not touch in standalone mode (`AI`, `DB`, `Sandbox`, `DISPATCHER`, `CodeGenObject`, `UserSecretsStore`, `THINK_DO`, `SPACE_DO`, `TEMPLATES_BUCKET`, `VibecoderStore`) is a throwing proxy: accessing any member throws `Unsupported binding "<name>" in standalone agent runtime`.
  - `createStateStore(client: SupabaseLike, sessionId: string, opts?: { debounceMs?: number })` → `{ load(): Promise<Record<string, unknown> | null>; persist(state: unknown): void; flush(): Promise<void> }` — trailing-debounced (default 300 ms) upsert into `agent_state`; `persist` is sync fire-and-forget; `flush` awaits the pending write.
  - `createConversationStore(client: SupabaseLike, sessionId: string)` → `{ append(kind: 'full' | 'compact', idx: number, message: unknown): Promise<void>; loadAll(kind: 'full' | 'compact'): Promise<unknown[]>; clear(): Promise<void> }` over `agent_conversations`.
  - `type SupabaseLike` — the minimal `.from(...)` PostgREST surface used, so unit tests inject fakes without network.

- [ ] **Step 1: Write the failing tests**

```ts
// agent-runtime/test/envAdapter.test.ts
import { describe, expect, it } from 'bun:test';
import { buildEnvAdapter } from '../src/envAdapter';

describe('buildEnvAdapter', () => {
    it('exposes string vars from the source', () => {
        const env = buildEnvAdapter({ CLOUDFLARE_AI_GATEWAY_URL: 'https://gw.example', TEMPLATES_REPOSITORY: 'x' });
        expect(env.CLOUDFLARE_AI_GATEWAY_URL).toBe('https://gw.example');
    });

    it('throws a named error when a Workers binding is touched', () => {
        const env = buildEnvAdapter({});
        expect(() => (env.AI as { gateway(id: string): unknown }).gateway('x')).toThrow(/Unsupported binding "AI"/);
        expect(() => (env.TEMPLATES_BUCKET as { get(k: string): unknown }).get('k')).toThrow(/TEMPLATES_BUCKET/);
    });
});
```

```ts
// agent-runtime/test/stateStore.test.ts
import { describe, expect, it } from 'bun:test';
import { createStateStore } from '../src/stateStore';

function fakeSupabase() {
    const upserts: Array<Record<string, unknown>> = [];
    let stored: Record<string, unknown> | null = null;
    const client = {
        from(table: string) {
            return {
                upsert: async (row: Record<string, unknown>) => { upserts.push({ table, ...row }); stored = row; return { error: null }; },
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => ({ data: stored ? { state: (stored as { state: unknown }).state } : null, error: null }),
                    }),
                }),
            };
        },
    };
    return { client, upserts };
}

describe('createStateStore', () => {
    it('debounces bursts into one upsert and flush awaits it', async () => {
        const { client, upserts } = fakeSupabase();
        const store = createStateStore(client as never, 's-1', { debounceMs: 10 });
        store.persist({ v: 1 });
        store.persist({ v: 2 });
        store.persist({ v: 3 });
        await store.flush();
        expect(upserts).toHaveLength(1);
        expect((upserts[0].state as { v: number }).v).toBe(3);
    });

    it('load returns null when no row exists', async () => {
        const { client } = fakeSupabase();
        const store = createStateStore(client as never, 's-1');
        expect(await store.load()).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test agent-runtime` → FAIL (modules missing).

- [ ] **Step 3: Implement `envAdapter.ts`**

```ts
// agent-runtime/src/envAdapter.ts
/**
 * Builds an Env-shaped object for the standalone runtime. String vars come
 * from process.env; Workers bindings are poisoned proxies so any code path
 * that would need Cloudflare infrastructure fails loudly and by name.
 */
const POISONED_BINDINGS = [
    'AI', 'DB', 'Sandbox', 'DISPATCHER', 'CodeGenObject', 'UserSecretsStore',
    'THINK_DO', 'SPACE_DO', 'TEMPLATES_BUCKET', 'VibecoderStore',
] as const;

function poisoned(name: string): unknown {
    return new Proxy({}, {
        get() { throw new Error(`Unsupported binding "${name}" in standalone agent runtime`); },
        apply() { throw new Error(`Unsupported binding "${name}" in standalone agent runtime`); },
    });
}

export function buildEnvAdapter(source: Record<string, string | undefined> = process.env): Env {
    const env: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) env[key] = value;
    }
    for (const name of POISONED_BINDINGS) {
        env[name] = poisoned(name);
    }
    return env as Env;
}
```

(`Env` resolves via the root `worker-configuration.d.ts` ambient types through the tsconfig `types` chain; if `tsc -p agent-runtime` cannot see `Env`, add `"types": ["bun-types", "../worker-configuration.d.ts"]`-style include or `/// <reference path="../../worker-configuration.d.ts" />` at the top of `envAdapter.ts` — pick whichever compiles; note the choice in your report.)

- [ ] **Step 4: Implement `stateStore.ts`**

```ts
// agent-runtime/src/stateStore.ts
export interface SupabaseLike {
    from(table: string): {
        upsert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
        select(columns?: string): {
            eq(column: string, value: string): {
                maybeSingle(): PromiseLike<{ data: { state: unknown } | null; error: { message: string } | null }>;
            };
        };
    };
}

export interface StateStore {
    load(): Promise<Record<string, unknown> | null>;
    persist(state: unknown): void;
    flush(): Promise<void>;
}

export function createStateStore(
    client: SupabaseLike,
    sessionId: string,
    opts: { debounceMs?: number } = {},
): StateStore {
    const debounceMs = opts.debounceMs ?? 300;
    let pending: unknown;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: Promise<void> = Promise.resolve();

    const write = () => {
        const state = pending;
        timer = null;
        inflight = inflight.then(async () => {
            const { error } = await client.from('agent_state').upsert({
                session_id: sessionId,
                state,
                updated_at: new Date().toISOString(),
            });
            if (error) {
                console.error(`agent_state persist failed: ${error.message}`);
            }
        });
    };

    return {
        async load() {
            const { data, error } = await client
                .from('agent_state')
                .select('state')
                .eq('session_id', sessionId)
                .maybeSingle();
            if (error) throw new Error(`agent_state load failed: ${error.message}`);
            return (data?.state as Record<string, unknown>) ?? null;
        },
        persist(state: unknown) {
            pending = state;
            if (timer) clearTimeout(timer);
            timer = setTimeout(write, debounceMs);
        },
        async flush() {
            if (timer) { clearTimeout(timer); write(); }
            await inflight;
        },
    };
}
```

- [ ] **Step 5: Implement `conversationStore.ts`**

```ts
// agent-runtime/src/conversationStore.ts
import type { SupabaseLike } from './stateStore';

/** PostgREST surface for agent_conversations (superset of SupabaseLike's from()). */
export interface ConversationClient {
    from(table: string): {
        insert(rows: Record<string, unknown> | Array<Record<string, unknown>>): PromiseLike<{ error: { message: string } | null }>;
        delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
        select(columns?: string): {
            eq(column: string, value: string): {
                eq(column: string, value: string): {
                    order(column: string, opts: { ascending: boolean }): PromiseLike<{ data: Array<{ message: unknown }> | null; error: { message: string } | null }>;
                };
            };
        };
    };
}

export interface ConversationStore {
    append(kind: 'full' | 'compact', idx: number, message: unknown): Promise<void>;
    loadAll(kind: 'full' | 'compact'): Promise<unknown[]>;
    clear(): Promise<void>;
}

export function createConversationStore(client: ConversationClient, sessionId: string): ConversationStore {
    return {
        async append(kind, idx, message) {
            const { error } = await client.from('agent_conversations').insert({
                session_id: sessionId, kind, idx, message,
            });
            if (error) throw new Error(`conversation append failed: ${error.message}`);
        },
        async loadAll(kind) {
            const { data, error } = await client
                .from('agent_conversations')
                .select('message')
                .eq('session_id', sessionId)
                .eq('kind', kind)
                .order('idx', { ascending: true });
            if (error) throw new Error(`conversation load failed: ${error.message}`);
            return (data ?? []).map((row) => row.message);
        },
        async clear() {
            const { error } = await client.from('agent_conversations').delete().eq('session_id', sessionId);
            if (error) throw new Error(`conversation clear failed: ${error.message}`);
        },
    };
}
```

Task 10 maps the agent's conversation persistence onto this store. Before finalizing signatures there, read how `codingAgent.ts` stores conversations today (`rg -n "full_conversations|compact_conversations" worker/agents` — the `this.sql` DDL near codingAgent.ts:102) and keep whatever ordering/compaction semantics it implements; if it replaces whole conversation snapshots rather than appending rows, add a `replaceAll(kind, messages: unknown[])` method here in the same style and use that instead (delete+bulk-insert under the hood).

- [ ] **Step 6: Verify** — `bun test agent-runtime` → all pass. Root suite untouched.

- [ ] **Step 7: Commit**

```bash
git add agent-runtime/src agent-runtime/test
git commit -m "feat: standalone env adapter, debounced state store, conversation store"
```

---

### Task 7: Realtime transport

**Files:**
- Create: `agent-runtime/src/transport.ts`
- Test: `agent-runtime/test/transport.test.ts`

**Interfaces:**
- Produces:
  - `createRealtimeTransport(options: { channelFactory: ChannelFactory; sessionId: string; onClientMessage: (raw: string, connection: ConnectionLike) => void }): AgentTransport`
  - `interface AgentTransport { ready(): Promise<void>; broadcast(message: Record<string, unknown>): void; connection: ConnectionLike; close(): Promise<void> }`
  - `type ChannelFactory = (topic: string) => RealtimeChannelLike` and `interface RealtimeChannelLike { on(type: 'broadcast', filter: { event: string }, cb: (msg: { payload: Record<string, unknown> }) => void): RealtimeChannelLike; subscribe(cb?: (status: string) => void): RealtimeChannelLike; send(msg: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown>; unsubscribe(): Promise<unknown> }` — satisfied by supabase-js `RealtimeChannel`; faked in tests.
  - `ConnectionLike` comes from Task 3 (`worker/agents/core/websocket.ts`).
- Channel contract (Global Constraints): topic `session:{sessionId}`, agent→browser event `"message"` with the websocket-message JSON as payload, browser→agent event `"client"` with `{ raw: string }` payload (raw is the same JSON string the frontend sends over WS today).

- [ ] **Step 1: Write the failing test**

```ts
// agent-runtime/test/transport.test.ts
import { describe, expect, it } from 'bun:test';
import { createRealtimeTransport } from '../src/transport';

function fakeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, (msg: { payload: Record<string, unknown> }) => void>();
    let subscribed: ((status: string) => void) | undefined;
    const channel = {
        on(_type: 'broadcast', filter: { event: string }, cb: (msg: { payload: Record<string, unknown> }) => void) {
            handlers.set(filter.event, cb);
            return channel;
        },
        subscribe(cb?: (status: string) => void) { subscribed = cb; return channel; },
        send: async (msg: { type: 'broadcast'; event: string; payload: Record<string, unknown> }) => { sent.push(msg); return 'ok'; },
        unsubscribe: async () => 'ok',
    };
    return {
        channel,
        sent,
        emitClient: (payload: Record<string, unknown>) => handlers.get('client')?.({ payload }),
        connect: () => subscribed?.('SUBSCRIBED'),
    };
}

describe('createRealtimeTransport', () => {
    it('subscribes to the session topic and resolves ready() on SUBSCRIBED', async () => {
        const fake = fakeChannel();
        let topic = '';
        const transport = createRealtimeTransport({
            channelFactory: (t) => { topic = t; return fake.channel; },
            sessionId: 's-1',
            onClientMessage: () => {},
        });
        const ready = transport.ready();
        fake.connect();
        await ready;
        expect(topic).toBe('session:s-1');
    });

    it('broadcast sends on the "message" event with the payload unwrapped', async () => {
        const fake = fakeChannel();
        const transport = createRealtimeTransport({
            channelFactory: () => fake.channel, sessionId: 's-1', onClientMessage: () => {},
        });
        const ready = transport.ready();
        fake.connect();
        await ready;
        transport.broadcast({ type: 'file_generated', file: { filePath: 'a.ts', fileContents: 'x' } });
        await new Promise((r) => setTimeout(r, 0));
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]).toMatchObject({ type: 'broadcast', event: 'message', payload: { type: 'file_generated' } });
    });

    it('routes inbound "client" events to onClientMessage with the raw string and a sendable connection', async () => {
        const fake = fakeChannel();
        const received: string[] = [];
        const transport = createRealtimeTransport({
            channelFactory: () => fake.channel,
            sessionId: 's-1',
            onClientMessage: (raw, connection) => {
                received.push(raw);
                connection.send(JSON.stringify({ type: 'ack' }));
            },
        });
        const ready = transport.ready();
        fake.connect();
        await ready;
        fake.emitClient({ raw: JSON.stringify({ type: 'generate_all' }) });
        await new Promise((r) => setTimeout(r, 0));
        expect(received).toEqual([JSON.stringify({ type: 'generate_all' })]);
        expect(fake.sent.some((m) => (m.payload as { type?: string })?.type === 'ack')).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test agent-runtime/test/transport.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// agent-runtime/src/transport.ts
import type { ConnectionLike } from 'worker/agents/core/websocket';

export interface RealtimeChannelLike {
    on(type: 'broadcast', filter: { event: string }, cb: (msg: { payload: Record<string, unknown> }) => void): RealtimeChannelLike;
    subscribe(cb?: (status: string) => void): RealtimeChannelLike;
    send(msg: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown>;
    unsubscribe(): Promise<unknown>;
}

export type ChannelFactory = (topic: string) => RealtimeChannelLike;

export interface AgentTransport {
    ready(): Promise<void>;
    broadcast(message: Record<string, unknown>): void;
    connection: ConnectionLike;
    close(): Promise<void>;
}

export function createRealtimeTransport(options: {
    channelFactory: ChannelFactory;
    sessionId: string;
    onClientMessage: (raw: string, connection: ConnectionLike) => void;
}): AgentTransport {
    const topic = `session:${options.sessionId}`;
    const channel = options.channelFactory(topic);

    let resolveReady: () => void;
    let rejectReady: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    const broadcast = (message: Record<string, unknown>): void => {
        void channel.send({ type: 'broadcast', event: 'message', payload: message }).catch((error) => {
            console.error(`realtime broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    };

    const connection: ConnectionLike = {
        id: `realtime:${options.sessionId}`,
        send(data: string) {
            broadcast(JSON.parse(data) as Record<string, unknown>);
        },
        url: null,
    };

    channel
        .on('broadcast', { event: 'client' }, ({ payload }) => {
            const raw = typeof payload.raw === 'string' ? payload.raw : JSON.stringify(payload);
            options.onClientMessage(raw, connection);
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') resolveReady();
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                rejectReady(new Error(`realtime channel ${topic} failed to subscribe: ${status}`));
            }
        });

    return {
        ready: () => readyPromise,
        broadcast,
        connection,
        close: async () => { await channel.unsubscribe(); },
    };
}
```

Wiring note for Task 10: the real factory is `(topic) => supabase.channel(topic, { config: { broadcast: { self: false }, private: true } })` with `supabase.realtime.setAuth(SUPABASE_SESSION_JWT)` called before subscribing. Verify the exact supabase-js v2 private-channel API against `node_modules/@supabase/supabase-js` typings when wiring (the fake-based unit tests are API-shape-agnostic by design).

- [ ] **Step 4: Verify** — `bun test agent-runtime` → all pass.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/src/transport.ts agent-runtime/test/transport.test.ts
git commit -m "feat: supabase realtime transport with connection shim"
```

---

### Task 8: LocalSandboxService

**Files:**
- Create: `agent-runtime/src/localSandbox.ts`
- Adopt if present (untracked from a killed earlier task): `worker/services/sandbox/staticAnalysisParsers.ts` + `test/worker/services/sandbox/staticAnalysisParsers.test.ts` — verify they compile and their vitest passes, then commit them with this task. If absent, create `worker/services/sandbox/staticAnalysisParsers.ts` with `parseESLintJson(stdout: string): CodeIssue[]`, `parseTscOutput(output: string): CodeIssue[]`, `summarizeIssues(issues: CodeIssue[])` extracted verbatim from `sandboxSdkClient.ts:1604-1732` (the parsing logic inside `runStaticAnalysisCode` and `mapESLintSeverity`), leaving `sandboxSdkClient.ts` unmodified (the Workers client keeps its inline copy for now; consolidation is Phase 4 cleanup).
- Test: `agent-runtime/test/localSandbox.test.ts`

**Interfaces:**
- Consumes: `BaseSandboxService` abstract contract (`worker/services/sandbox/BaseSandboxService.ts:220-312` — 15 abstract methods, base constructor `super(sandboxId: string)`), `ProcessMonitor`/log+error storage from `container/` (read `container/process-monitor.ts` and `container/storage.ts` exports first; import them as libraries — they are plain Bun modules), `InstanceCreationRequest`/response types from `worker/services/sandbox/sandboxTypes.ts`.
- Produces: `class LocalSandboxService extends BaseSandboxService` with `constructor(options: { sessionId: string; workspaceDir: string; previewBaseUrl?: string; devPort?: number })`. Instance semantics: exactly one instance, `instanceId = 'i-' + sessionId`, files under `${workspaceDir}/${instanceId}`.
- Method mapping (implement all 15; each returns the exact response shapes from `sandboxTypes.ts`):
  - `initialize()` — ensure workspaceDir exists (`mkdir -p`).
  - `createInstance(options)` — write `options.files` to disk (plain `node:fs/promises`, `mkdir` recursive per file dir); parse `.donttouch_files.json`/`.redacted_files.json` like `sandboxSdkClient.ts:1026-1030`; run `bun install` via `Bun.spawn` with cwd = instance dir (5-minute timeout); start the dev server through a `ProcessMonitor` instance configured with `instanceId`, `PORT=devPort` (default 8080), command from `options.initCommand ?? 'bun run dev'`, env `VITE_LOGGER_TYPE=json`; wait for readiness by polling the monitor's log store for the same patterns as `sandboxSdkClient.ts:582-589` (`/http:\/\/[^\s]+/`, `/ready in \d+/i`, `/Local:\s+http/i`, `/Network:\s+http/i`, `/server running/i`, `/listening on/i`) up to 10 s; return `{ success: true, runId: instanceId, previewURL, processId }` where `previewURL = previewBaseUrl ?? 'http://localhost:' + devPort`.
  - `writeFiles(instanceId, files)` — donttouch filtering (metadata JSON persisted at `${workspaceDir}/${instanceId}-metadata.json`, same shape as the Workers client's `InstanceMetadata`), write via fs, `touch .reload-trigger` when `.ts/.tsx` files written (Bun: `await Bun.write(path, '')` is NOT touch — use `fs.utimes` or write current timestamp content; match "file mtime changes" semantics).
  - `getFiles(instanceId, filePaths?)` — default to `.important_files.json` expansion (read the JSON, expand directories via `fs.readdir` recursive), apply `redacted_files` → `'[REDACTED]'`.
  - `executeCommands(instanceId, commands, timeout?)` — sequential `Bun.spawn(['sh', '-c', command])` with cwd = instance dir, per-command timeout default 60 s; map to `CommandExecutionResult { command, success: exitCode === 0, output: stdout, error: stderr || undefined, exitCode }`.
  - `getLogs(instanceId, onlyRecent?, durationSeconds?)` — read from the in-process log storage (`container/` `StorageManager`/log store APIs; honor reset-on-read when `onlyRecent` and duration filtering, mirroring `monitor-cli logs get --format raw --reset --duration N`).
  - `getInstanceErrors(instanceId, clear?)` / `clearInstanceErrors` — the error store equivalents (`errors list --format json` / `errors clear`).
  - `runStaticAnalysisCode(instanceId)` — `Promise.allSettled` of `bun run lint` and `bunx tsc -b --incremental --noEmit --pretty false` (cwd instance dir, 120 s timeouts), parsed with `staticAnalysisParsers`, summaries via `summarizeIssues`, `rawOutput` strings in the same `STDOUT: ...\nSTDERR: ...` format as `sandboxSdkClient.ts:1641,1705`.
  - `getInstanceStatus` — healthy iff the monitor reports an active process; include `previewURL` from metadata. `getInstanceDetails` — metadata + uptime. `listAllInstances` — the single instance if it exists. `shutdownInstance` — stop the monitor, keep files. `updateProjectName` — same two `sed`-equivalent replacements as `sandboxSdkClient.ts:857-870` implemented with fs read/replace/write (no shelling to sed), update metadata, return boolean.
  - `deployToCloudflareWorkers(instanceId, target?)` — return `{ success: false, message: 'Deployment is not available from the standalone agent runtime in phase 1', error: 'unsupported' }`.
- Static template methods (`listTemplates`/`getTemplateDetails` on the base) are handled by Task 9's template source — not this task.

- [ ] **Step 1: Write the failing test** (real fs + real processes in a tmpdir — no mocks)

```ts
// agent-runtime/test/localSandbox.test.ts
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandboxService } from '../src/localSandbox';

const workspaceDir = mkdtempSync(join(tmpdir(), 'vibesdk-local-sandbox-'));
afterAll(() => rmSync(workspaceDir, { recursive: true, force: true }));

describe('LocalSandboxService', () => {
    const service = new LocalSandboxService({ sessionId: 'test-1', workspaceDir, devPort: 8189 });

    it('creates an instance: writes files, installs deps, starts a dev server, reports ready', async () => {
        const result = await service.createInstance({
            projectName: 'local-app',
            initCommand: 'bun run dev',
            files: [
                { filePath: 'package.json', fileContents: JSON.stringify({ name: 'local-app', scripts: { dev: 'bun run server.ts' } }) },
                { filePath: 'server.ts', fileContents: 'const s = Bun.serve({ port: Number(process.env.PORT ?? 8189), fetch: () => new Response("ok") }); console.log(`listening on http://localhost:${s.port}`);' },
                { filePath: '.important_files.json', fileContents: '["server.ts"]' },
                { filePath: '.donttouch_files.json', fileContents: '["package.json"]' },
                { filePath: '.redacted_files.json', fileContents: '[]' },
            ],
        });
        expect(result.success).toBe(true);
        expect(result.runId).toBe('i-test-1');
        expect(result.previewURL).toContain('8189');
        const health = await service.getInstanceStatus('i-test-1');
        expect(health.isHealthy).toBe(true);
    }, 30_000);

    it('writeFiles respects donttouch and touches the reload trigger for ts files', async () => {
        const write = await service.writeFiles('i-test-1', [
            { filePath: 'extra.ts', fileContents: 'export const x = 1;' },
            { filePath: 'package.json', fileContents: '{}' },
        ]);
        expect(write.results.find((r) => r.file === 'extra.ts')?.success).toBe(true);
        expect(write.results.find((r) => r.file === 'package.json')?.success).toBe(false);
    });

    it('executeCommands returns per-command exit codes', async () => {
        const result = await service.executeCommands('i-test-1', ['echo hello', 'exit 3']);
        expect(result.results[0]).toMatchObject({ success: true });
        expect(result.results[0].output.trim()).toBe('hello');
        expect(result.results[1]).toMatchObject({ success: false, exitCode: 3 });
    });

    it('getFiles applies redaction and important-files default', async () => {
        const files = await service.getFiles('i-test-1', ['server.ts']);
        expect(files.success).toBe(true);
        expect(files.files[0].filePath).toBe('server.ts');
    });

    it('shutdownInstance stops the dev server', async () => {
        const down = await service.shutdownInstance('i-test-1');
        expect(down.success).toBe(true);
        const health = await service.getInstanceStatus('i-test-1');
        expect(health.isHealthy ?? false).toBe(false);
    }, 15_000);
});
```

The `createInstance` test intentionally uses a `package.json` with zero dependencies so `bun install` completes offline in milliseconds.

- [ ] **Step 2: Run to verify failure**, then implement per the method mapping above. Read `container/process-monitor.ts` + `container/storage.ts` first and reuse their classes directly (construct with explicit db paths under `${workspaceDir}/data/`); only fall back to a thin internal supervisor (Bun.spawn + restart loop + in-memory ring-buffer logs implementing the same getLogs/getErrors semantics) if the container classes prove import-incompatible — and say so in your report with the exact incompatibility.

- [ ] **Step 3: Verify** — `bun test agent-runtime/test/localSandbox.test.ts` (all pass; suite total green), root suite untouched unless parsers were created/adopted → `bun run typecheck && bun run test` green.

- [ ] **Step 4: Commit**

```bash
git add agent-runtime/src/localSandbox.ts agent-runtime/test/localSandbox.test.ts worker/services/sandbox/staticAnalysisParsers.ts test/worker/services/sandbox/staticAnalysisParsers.test.ts
git commit -m "feat: local sandbox service over fs/exec with in-process supervision"
```

---

### Task 9: Template source seam (in place)

**Files:**
- Create: `worker/services/sandbox/templateSource.ts`
- Modify: `worker/services/sandbox/BaseSandboxService.ts:78-209` (statics delegate to the seam), `worker/services/sandbox/factory.ts` (override hook)
- Test: `test/worker/services/sandbox/templateSource.test.ts`

**Interfaces:**
- Produces:
  - `interface TemplateZipSource { getCatalog(): Promise<TemplateInfo[]>; getZip(name: string, downloadDir?: string): Promise<ArrayBuffer> }`
  - `setTemplateSource(source: TemplateZipSource): void` / default implementation `R2TemplateSource` reading `getRuntimeEnv().TEMPLATES_BUCKET` exactly as the current statics do (catalog key `template_catalog.json`, zip key `{downloadDir}/{name}.zip` or `{name}.zip`)
  - `createHttpTemplateSource(baseUrl: string): TemplateZipSource` — `fetch(baseUrl + '/template_catalog.json')`, `fetch(baseUrl + '/' + name + '.zip')` (with optional downloadDir prefix), errors surfaced with status codes
  - In `factory.ts`: `setSandboxServiceFactory(factory: (sessionId: string, agentId: string) => BaseSandboxService): void` — when set, `getSandboxService` returns `factory(sessionId, agentId)` before any env checks.
- `BaseSandboxService.listTemplates`/`getTemplateDetails` keep their exact signatures, caching, filtering (drop `next` templates) and parsing behavior — only the byte-fetching moves behind the seam.

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/templateSource.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpTemplateSource, setTemplateSource, resetTemplateSourceForTests } from 'worker/services/sandbox/templateSource';
import { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';

afterEach(() => resetTemplateSourceForTests());

describe('template source seam', () => {
    it('listTemplates uses an injected source', async () => {
        setTemplateSource({
            getCatalog: async () => [
                { name: 'vite-app', language: 'ts', frameworks: ['react'], description: { selection: 's', usage: 'u' } } as never,
                { name: 'next-app', language: 'ts', frameworks: [], description: { selection: 's', usage: 'u' } } as never,
            ],
            getZip: async () => new ArrayBuffer(0),
        });
        const result = await BaseSandboxService.listTemplates();
        expect(result.success).toBe(true);
        expect(result.templates.map((t) => t.name)).toEqual(['vite-app']); // next-* filtered, existing behavior
    });

    it('http source hits catalog and zip URLs', async () => {
        const urls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            urls.push(String(input));
            return new Response(JSON.stringify([]), { status: 200 });
        }) as typeof fetch;
        try {
            const source = createHttpTemplateSource('https://templates.example.com');
            await source.getCatalog();
            expect(urls[0]).toBe('https://templates.example.com/template_catalog.json');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
```

- [ ] **Step 2: Run to verify failure**, then implement: move the two fetch blocks out of the statics into `R2TemplateSource` (module-default), leave all parsing/caching logic in `BaseSandboxService` untouched, add `setTemplateSource`/`resetTemplateSourceForTests`. In `BaseSandboxService.ts`, the `import { env } from 'cloudflare:workers'` can now be REMOVED if `env` was only used by the statics (verify with `rg -n "env\." worker/services/sandbox/BaseSandboxService.ts`) — the R2 source uses `getRuntimeEnv()` instead. Add the factory override hook to `factory.ts`:

```ts
let sandboxServiceFactoryOverride: ((sessionId: string, agentId: string) => BaseSandboxService) | null = null;

export function setSandboxServiceFactory(factory: (sessionId: string, agentId: string) => BaseSandboxService): void {
    sandboxServiceFactoryOverride = factory;
}

export function getSandboxService(sessionId: string, agentId: string): BaseSandboxService {
    if (sandboxServiceFactoryOverride) {
        return sandboxServiceFactoryOverride(sessionId, agentId);
    }
    // ...existing branches unchanged...
}
```

- [ ] **Step 3: Verify** — `bun run typecheck && bun run test` green (Workers behavior identical: default source is R2).

- [ ] **Step 4: Commit**

```bash
git add worker/services/sandbox/templateSource.ts worker/services/sandbox/BaseSandboxService.ts worker/services/sandbox/factory.ts test/worker/services/sandbox/templateSource.test.ts
git commit -m "refactor: template zip source seam and sandbox factory override hook"
```

---

### Task 10: StandaloneAgent + bootstrap entrypoint

The heart of the phase. `StandaloneAgent` implements `AgentHost` (= `AgentInfrastructure<AgentState> & ICodingAgent & extras`, Task 3) with: in-memory state + Task 6 stores, Task 7 transport, Task 4 injected real-fs git, Task 8 LocalSandboxService via the Task 9 factory override. `worker/agents/core/codingAgent.ts` is the reference implementation — the delegation bodies are cribbed from it (they are one-to-three-liners calling `this.behavior.*` / services); the infrastructure plumbing is new. Do NOT import `codingAgent.ts` (it pulls the `agents` SDK at runtime).

**Files:**
- Create: `agent-runtime/src/standaloneAgent.ts`, `agent-runtime/src/main.ts`, `agent-runtime/src/bootstrapEnv.ts`
- Test: `agent-runtime/test/standaloneAgent.test.ts`

**Interfaces:**
- Consumes: everything above, plus behavior construction — read how `codingAgent.ts` instantiates behaviors (`rg -n "new PhasicBehavior|createBehavior|BehaviorFactory" worker/agents/core` first) and reuse the same construction path. Phase 1 supports `phasic` and `agentic` behaviors; a `think` init request must fail fast: `throw new Error('think behavior is not supported in the standalone agent runtime (phase 1)')`.
- Produces:
  - `class StandaloneAgent` with `static async boot(options: StandaloneBootOptions): Promise<StandaloneAgent>` where

```ts
export interface StandaloneBootOptions {
    sessionId: string;
    agentId: string;
    workspaceDir: string;
    env: Env;                          // from buildEnvAdapter()
    transport: AgentTransport;         // Task 7
    stateStore: StateStore;            // Task 6
    conversationStore: ConversationStore; // Task 6
    sandbox: LocalSandboxService;      // Task 8
    initArgs?: Record<string, unknown>; // agent_sessions.init_args when no persisted state exists
}
```

  - `boot()` sequence: load state via `stateStore.load()`; if null, build the initial state the same way `codingAgent.ts`'s `initialState` + `initialize(initArgs)` do (crib the defaults verbatim from codingAgent.ts:73-97; `initialize` runs blueprint generation — LLM — only when `initArgs` demand it); construct services (`FileManager`, `DeploymentManager`, `GitVersionControl` with `{ fs: nodeFsPromisesAdapter(workspaceDir) }`); register `setSandboxServiceFactory(() => options.sandbox)`; wire `broadcast()` → `transport.broadcast({ type, ...data })`; send `agent_connected` with `{ state: this.state, templateDetails: <same source codingAgent uses>, previewUrl }`; return the instance.
  - `setState(state)` = assign in-memory + `stateStore.persist(state)`; `state` getter returns the in-memory object; `getWebSockets()` returns `[transport.connection]` shaped as WebSocket-like for `broadcastToConnections` (it only calls `.send`).
  - Conversation methods (`setConversationState`/`getConversationState`/`addConversationMessage`/`clearConversation`) — crib codingAgent's semantics but persist through `conversationStore` (use `replaceAll` if that is what the reference does — decide from the code, not from guesses, and document which in your report).
  - Stubs (explicit errors or safe no-ops matching the out-of-scope list in Global Constraints): vault/secrets client → broadcasts nothing, `getDecryptedSecret` throws `unsupported`; `captureBrowserConsoleLogs`/screenshots → returns a failed result with `'screenshots unsupported in standalone runtime (phase 1)'`; GitHub export → error result; `deployToCloudflare` → error result (matches Task 8's sandbox stub); D1 `AppService` writes → a `NoopAppEvents` seam that logs `{ event, payload }` at info level and continues (find the AppService call sites in the reference class first; there are few).
  - `handleClientMessage(raw: string)` → `handleWebSocketMessage(this, transport.connection, raw)` (the Task 3 handler, unchanged).
  - `shutdown()` → `stateStore.flush()`, `sandbox.shutdownInstance(...)` best-effort, `transport.close()`.
  - `main.ts`: reads `bootstrapEnv.ts`-validated env (`SESSION_ID`, `AGENT_ID`, `WORKSPACE_DIR` default `/workspace`, `SUPABASE_URL`, `SUPABASE_SESSION_JWT`, `TEMPLATES_BASE_URL`, optional `SELF_PREVIEW_BASE_URL`, gateway/provider vars per Global Constraints); builds the real supabase client (`createClient(SUPABASE_URL, SUPABASE_SESSION_JWT ...)` — for PostgREST use the JWT as the auth (global headers `Authorization: Bearer <jwt>` with the anon key as apikey if the local stack requires both; verify against local supabase and document); `supabase.realtime.setAuth(jwt)`; `setRuntimeEnv(buildEnvAdapter())`; `setTemplateSource(createHttpTemplateSource(TEMPLATES_BASE_URL))`; loads `agent_sessions.init_args` when state is missing; boots; heartbeats `agent_sessions.last_activity_at` every 60 s; handles SIGTERM/SIGINT → `shutdown()`.
- `bootstrapEnv.ts`: `parseBootstrapEnv(source: Record<string, string | undefined>): BootstrapEnv` — throws listing ALL missing required vars in one error.

- [ ] **Step 1: Write the failing tests** (fakes for transport/stores/sandbox; no network, no LLM)

```ts
// agent-runtime/test/standaloneAgent.test.ts
import { describe, expect, it } from 'bun:test';
import { StandaloneAgent } from '../src/standaloneAgent';
import { buildEnvAdapter } from '../src/envAdapter';
import { parseBootstrapEnv } from '../src/bootstrapEnv';

function fakes() {
    const broadcasts: Array<Record<string, unknown>> = [];
    const persisted: unknown[] = [];
    return {
        broadcasts,
        persisted,
        transport: {
            ready: async () => {},
            broadcast: (m: Record<string, unknown>) => { broadcasts.push(m); },
            connection: { id: 'c1', send: (d: string) => { broadcasts.push(JSON.parse(d)); }, url: null },
            close: async () => {},
        },
        stateStore: {
            load: async () => null,
            persist: (s: unknown) => { persisted.push(s); },
            flush: async () => {},
        },
        conversationStore: {
            append: async () => {}, loadAll: async () => [], clear: async () => {},
            replaceAll: async () => {},
        },
    };
}

describe('parseBootstrapEnv', () => {
    it('lists every missing var in one error', () => {
        expect(() => parseBootstrapEnv({})).toThrow(/SESSION_ID.*AGENT_ID.*SUPABASE_URL/s);
    });
});

describe('StandaloneAgent.boot', () => {
    it('initializes default state, persists it, and emits agent_connected', async () => {
        const f = fakes();
        const agent = await StandaloneAgent.boot({
            sessionId: 's-1',
            agentId: 'a-1',
            workspaceDir: '/tmp/vibesdk-test-s1',
            env: buildEnvAdapter({}),
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
            initArgs: undefined, // no blueprint generation — bare boot
        });
        expect(agent.state.sessionId).toBe('s-1');
        const connected = f.broadcasts.find((b) => b.type === 'agent_connected');
        expect(connected).toBeDefined();
        expect(f.persisted.length).toBeGreaterThan(0);
    });

    it('setState persists through the store and updates the getter', async () => {
        const f = fakes();
        const agent = await StandaloneAgent.boot({
            sessionId: 's-2', agentId: 'a-2', workspaceDir: '/tmp/vibesdk-test-s2',
            env: buildEnvAdapter({}),
            transport: f.transport as never, stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
        });
        const before = f.persisted.length;
        agent.setState({ ...agent.state, projectName: 'renamed' });
        expect(agent.state.projectName).toBe('renamed');
        expect(f.persisted.length).toBe(before + 1);
    });

    it('rejects think behavior init', async () => {
        const f = fakes();
        await expect(StandaloneAgent.boot({
            sessionId: 's-3', agentId: 'a-3', workspaceDir: '/tmp/vibesdk-test-s3',
            env: buildEnvAdapter({}),
            transport: f.transport as never, stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: {} as never,
            initArgs: { behaviorType: 'think', query: 'x' },
        })).rejects.toThrow(/think behavior is not supported/);
    });
});
```

Adjust field expectations to the real `initialState` defaults you crib (e.g. if bare boot requires `initArgs`, make bare boot construct a minimal idle state — the test's intent is: boot without LLM works, snapshot broadcast happens, persistence flows). Do NOT relax the three assertions' intents.

- [ ] **Step 2: Implement.** Order of work: `bootstrapEnv.ts` (small, pure) → `standaloneAgent.ts` (crib `codingAgent.ts` top-to-bottom: constructor wiring, `initialState` defaults, every `ICodingAgent` delegation, the conversation methods, `AgentHost` extras from Task 3) → `main.ts`. While cribbing, every `this.env.X` read flows through the adapter naturally; every binding access must be behind one of the stubs — if `tsc -p agent-runtime` or a test hits a poisoned binding, add the missing stub, never un-poison the binding. Where behavior construction requires arguments you cannot trace, STOP and report NEEDS_CONTEXT with the exact constructor site.

- [ ] **Step 3: Wire agent-runtime typecheck into root**

Root `package.json`: `"typecheck": "tsc -b --incremental --noEmit"` → append `" && tsc -p agent-runtime --noEmit"` (single script, both runtimes gate every future commit).

- [ ] **Step 4: Verify** — `bun test agent-runtime` all green; `bun run typecheck && bun run test` green.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/src agent-runtime/test package.json
git commit -m "feat: standalone agent implementing AgentHost over postgres/realtime/local sandbox"
```

---

### Task 11: Local e2e smoke driver

**Files:**
- Create: `scripts/agent-runtime/dev-session.ts`
- Test: `agent-runtime/test/e2e.integration.test.ts` (gated on `SUPABASE_LOCAL=1`)

**Interfaces:**
- Consumes: everything; real local Supabase; NO LLM required (the smoke path exercises boot, snapshot, a client→agent round trip, and state persistence — generation with a real key is a documented manual step, not a test).
- Produces: `bun scripts/agent-runtime/dev-session.ts --query "build a todo app"` — seeds `agent_sessions` (service role), mints a session JWT (sign HS256 with the local stack's `SUPABASE_JWT_SECRET` from `bunx supabase status`; claims `{ session_id, role: 'authenticated', exp: now+3600 }`), spawns `bun agent-runtime/src/main.ts` with the env contract from Task 10, subscribes to `session:{id}` as a browser-side client, prints every broadcast, sends `get_model_configs` and prints the `model_configs_info` response, then SIGTERMs the agent and verifies `agent_state` has a row.

- [ ] **Step 1: Write the gated e2e test** — same flow as the driver, programmatic:

```ts
// agent-runtime/test/e2e.integration.test.ts
import { describe, expect, it } from 'bun:test';

const gate = process.env.SUPABASE_LOCAL === '1' ? describe : describe.skip;

gate('standalone agent e2e (local supabase)', () => {
    it('boots, emits agent_connected, answers get_model_configs, persists state', async () => {
        const { runSmokeSession } = await import('../../scripts/agent-runtime/dev-session');
        const result = await runSmokeSession({ query: 'smoke test app', timeoutMs: 60_000 });
        expect(result.received.some((m) => m.type === 'agent_connected')).toBe(true);
        expect(result.received.some((m) => m.type === 'model_configs_info')).toBe(true);
        expect(result.statePersisted).toBe(true);
    }, 90_000);
});
```

- [ ] **Step 2: Implement `dev-session.ts`** exporting `runSmokeSession(options: { query: string; timeoutMs?: number }): Promise<{ received: Array<{ type: string }>; statePersisted: boolean }>` plus a CLI `main` when executed directly. Read local keys via `bunx supabase status -o env` (parse KEY=value lines; fall back to plain `status` text parsing). JWT signing: use the `jose` npm package if present in the tree, else implement HS256 with `crypto.subtle` (HMAC-SHA256 over `base64url(header).base64url(payload)` — ~20 lines, no new dependency).

- [ ] **Step 3: Verify** — with Docker: `bunx supabase start && bunx supabase db reset && SUPABASE_LOCAL=1 bun test agent-runtime/test/e2e.integration.test.ts` → pass. Without Docker: suite skips green; run whatever you can and report exactly which mode you verified.

- [ ] **Step 4: Commit**

```bash
git add scripts/agent-runtime agent-runtime/test/e2e.integration.test.ts
git commit -m "feat: local e2e smoke driver for the standalone agent"
```

---

### Task 12: Sandbox template + boot scripts (staging-gated)

**Files:**
- Create: `scripts/superserve/build-agent-template.ts`, `scripts/superserve/boot-agent-sandbox.ts`

**Interfaces:**
- Consumes: `@superserve/sdk@0.7.7` (already a dependency), verified backend facts: template steps cannot COPY local files (clone the repo instead), exec default timeout 30 s (pass explicit timeouts), long-lived processes need `setsid nohup ... &` detachment, boxd SIGKILLs the exec's process group on timeout.
- Produces:
  - `build-agent-template.ts` — `Template.create({ name: process.env.SUPERSERVE_AGENT_TEMPLATE ?? 'vibesdk-agent', from: 'ubuntu:24.04', vcpu: 4, memoryMib: 8192, diskMib: 10240, steps: [...], readyCmd: 'test -x /usr/local/bin/bun' })` with steps: apt install `curl ca-certificates git unzip procps`; install Node 22 (nodesource); install bun + symlinks; `git clone --depth 1 --branch ${VIBESDK_REF ?? 'main'} ${VIBESDK_REPO ?? 'https://github.com/cloudflare/vibesdk'} /opt/vibesdk && cd /opt/vibesdk && bun install`; `mkdir -p /workspace`; env `VITE_LOGGER_TYPE=json`; then `waitUntilReady({ onLog })`. Guard: exits 1 with a message if `SUPERSERVE_API_KEY` unset. Deletes-then-recreates on name collision (connect → delete → create).
  - `boot-agent-sandbox.ts` — creates `Sandbox.create({ name: 'agent-' + sessionId, fromTemplate, envVars: { SESSION_ID, AGENT_ID, WORKSPACE_DIR: '/workspace', SUPABASE_URL, SUPABASE_SESSION_JWT, TEMPLATES_BASE_URL, CLOUDFLARE_AI_GATEWAY_URL, CLOUDFLARE_AI_GATEWAY_TOKEN }, network: { allowOut: [npm/github/AI-provider/supabase hosts — derive supabase host from SUPABASE_URL] }, metadata: { vibesdk_kind: 'agent', vibesdk_session: sessionId } })`, then starts the agent detached: `commands.run("cd /opt/vibesdk && setsid nohup bun agent-runtime/src/main.ts > /workspace/agent.log 2>&1 < /dev/null & echo $!", { timeoutMs: 15_000 })`, prints the sandbox id, preview URL for port 8080, and `tail`-style follow instructions (`commands.run('tail -n 50 /workspace/agent.log', { timeoutMs: 10_000 })`).
- Both scripts are manual/staging tools: NEVER run them in tests or CI; typecheck-only verification. A cloud sandbox cannot reach a laptop's local Supabase — the boot script requires a hosted Supabase project (document this in the script header comment).

- [ ] **Step 1: Write both scripts** per the contract above (full code, no placeholders — the Superserve SDK calls mirror `Sandbox.create`/`Template.create` signatures from `node_modules/@superserve/sdk/dist/index.d.ts`; verify option names there while writing).
- [ ] **Step 2: Verify** — `bunx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck scripts/superserve/build-agent-template.ts scripts/superserve/boot-agent-sandbox.ts` → clean. Do NOT execute them.
- [ ] **Step 3: Commit**

```bash
git add scripts/superserve
git commit -m "feat: superserve agent template and sandbox boot scripts (staging)"
```

---

### Task 13: Verification sweep, protocol parity, runbook

**Files:**
- Create: `docs/agent-runtime.md`
- Modify: `.superpowers/sdd/progress.md` (ledger)

- [ ] **Step 1: Full gates**

Run: `bun run typecheck && bun run lint && bun run test && bun test agent-runtime`
Expected: all green. `rg -n "not supported in the standalone|unsupported" agent-runtime/src` shows only the sanctioned Phase-1 stubs (vault, screenshots, github export, deploy, think, AppService noop).

- [ ] **Step 2: Protocol parity check**

Run: `rg -o "WebSocketMessageResponses\.[A-Z_]+" worker/agents -N | sort -u | wc -l` and confirm every response constant used by the agent tree compiles against the transport path (they all funnel through `broadcastToConnections`/`AgentHost.broadcast`, so `bun run typecheck` passing IS the parity proof — state that explicitly in the report with the constant count).

- [ ] **Step 3: Write `docs/agent-runtime.md`** — runbook covering: what the package is; env contract table (the Global Constraints list); local dev loop (`supabase start`, `db reset`, `SUPABASE_LOCAL=1` tests, `dev-session.ts`); sandbox boot (template build, hosted-supabase requirement, boot script); Phase-1 stub list and where Phase 2/3 picks them up; the debounced-persistence caveat (a crash can lose the last <300 ms of state; `agent_messages` is the replay log for Phase 3 hardening).

- [ ] **Step 4: Ledger + commit**

```bash
git add docs/agent-runtime.md
git commit -m "docs: standalone agent runtime runbook"
```

Append to `.superpowers/sdd/progress.md`: `Phase 1 complete through Task 13 (commits <range>)` plus any carried Minors.

---

## Self-Review Notes (applied)

- Spec §6 Phase 1 coverage: state→Postgres (T5/T6/T10), transport→Realtime (T7/T10), LocalSandboxService (T8), real git (T4/T10), in-sandbox dev server + logs/errors (T8), template source without R2 (T9), bootable-in-sandbox (T12), e2e observable protocol (T11), Workers build kept green throughout (every task's gate).
- Deliberate scope cuts vs spec §6.1, all traceable: blueprint-generation-under-LLM is exercised only via the documented manual path (no LLM in CI); "runs in a Superserve sandbox" is delivered as staging scripts (T12) because cloud sandboxes cannot reach local Supabase; frontend stays on PartySocket until Phase 2/3 — `dev-session.ts` is the protocol client.
- Type-consistency: `ConnectionLike`/`AgentHost` (T3) consumed by T7/T10; `StateStore`/`ConversationStore` (T6) consumed by T10; `GitFsPromises` (T4) consumed by T10; `setSandboxServiceFactory`/`setTemplateSource` (T9) consumed by T10; table names (T5) consumed by T6/T10/T11.
- Known judgment points delegated to implementers with explicit stop-conditions: exact conversation persistence semantics (T6 note + T10), behavior constructor arguments (T10 NEEDS_CONTEXT rule), container/ class import compatibility (T8 fallback rule).

