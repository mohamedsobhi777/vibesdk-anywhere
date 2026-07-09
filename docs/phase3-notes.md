# Phase 3 — Notes

Preview/deploy lifecycle + the DO-codegen-pipeline-coupled endpoints, re-sourced from the
Superserve sandbox / Postgres / Supabase Storage. Per `docs/superpowers/plans/2026-07-09-phase3.md`.
As with the thin vertical, most of this cannot be live-validated in this environment (needs a live
Superserve sandbox producing git/screenshots + hosted Supabase Storage) — deliverables are
type-correct + unit-tested (faked Superserve/storage) + this runbook; the live run is the user's step.

## Shipped (each impl + reviewed SHIP)

| Task | Change | Commit |
|---|---|---|
| 1 | `GET /api/apps/:id` summary + preview from Postgres (`agent_state` Drizzle mapping + `AgentStateService`; retired the DO RPC); wired the real `isFavorite`/`starCount` 2b-rest had stubbed | `c5e09a0` |
| 2 | GitHub export from the Superserve sandbox `.git` (`extractSandboxGitObjects` via `downloadDir`+`fflate`; rewired 3 call sites incl. the git-clone endpoint; `GitHubService` unchanged); added sandbox `timeoutSeconds` (4h) | `75f349c` |
| 3 | Screenshots → Supabase Storage (`isStandaloneRuntime`-branched abstraction, `screenshots` bucket); serve swap; Browser-Rendering capture made **optional** | `d390a47` |
| 4 | Deploy scoped to the live sandbox preview (option c): `deployProject` → `deployToSandbox` preview URL; honest UI copy (retired "permanently deployed to Cloudflare Workers"); Workers path byte-for-byte untouched | `c106f85` |

## Key decisions (made autonomously)
- **Deploy = the live Superserve sandbox preview (option c).** Superserve has one primitive (the
  Sandbox); there is no publish/deploy primitive to promote into. The broken "deploy to Cloudflare
  Workers" path (a stub that always failed) is retired; the preview URL is the honest product surface.
- **Vault deferred** (BYOK is an optional overlay, not load-bearing; the ephemeral-key session model
  is a security-posture decision, not a mechanical port).
- **Screenshots keep zero *hard* Cloudflare dependency**: capture (Cloudflare Browser Rendering REST,
  a hosted API — not a Workers binding) is optional and skips gracefully without creds.

## Verification (all green)
`bun run typecheck` 0; `bunx tsc -b --force` 0; `typecheck:agent-runtime` 0; `bun test agent-runtime`
74 pass / 3 skip / 0 fail; `lint` 0; `bun run build` OK. Worker vitest in directory batches (the env's
`@cloudflare/vitest-pool-workers` `EADDRNOTAVAIL` ceiling forces batching): database+config+api 151/2skip,
services 77, agents+utils 20, bun-test capabilities+vercelHandler 5, colocated inferutils 7 — **0 failures**.

## Important deferred / flagged items (with next steps)

1. **Screenshot UPLOAD has no safe credential yet (load-bearing for the feature).** `uploadImage` runs
   INSIDE the Superserve sandbox (the agent captures + uploads). We deliberately did **not** wire
   `SUPABASE_SERVICE_ROLE_KEY` into the sandbox env — that would hand an RLS-bypassing key to a process
   running LLM-generated code (a real security regression). So screenshot upload throws
   `SUPABASE_SERVICE_ROLE_KEY is not configured` on the standalone runtime until a secure design lands:
   **(a)** the agent POSTs bytes to an authenticated Vercel API endpoint (session-JWT) that does the
   service-role upload, or **(b)** the API mints a short-lived signed upload URL the agent uses, or
   **(c)** session-JWT-scoped Supabase Storage RLS policies. Screenshots are secondary (app thumbnail),
   so this is deferred, but the feature is non-functional end-to-end until it's built.
2. **GitHub token cache is DO-backed and dead for new sessions.** The primary OAuth-callback export
   path works (real token from `exchangeCodeForTokens`); the cached-token path (`getGitHubToken()` DO
   RPC) 401s gracefully. A token store (Postgres, per-user) is a follow-up if the cached path is wanted.
3. **`getAppDetails` fail-open hardening.** A genuine DB *connection* error (vs missing-row) still 500s
   via the outer catch (pre-existing `connectToAgent` behavior). Since this endpoint is public/every-page,
   wrapping the service reads to degrade to null is worth a follow-up.
4. **GitHub-export controller path has no unit test** (importing `GitHubExporterController` hits the
   pre-existing `@octokit`/`content-type` vitest-pool-workers bundling failure; the shared composition is
   covered via `gitProtocol.test.ts`).
5. **Real permanent hosting** (option a: keep-alive/pause-resume the sandbox as a stable deployment;
   option b: build→push to a real host) — a product/cost decision, not built here.
6. **Sandbox lifecycle**: `bootAgentSandbox` now sets `timeoutSeconds` (4h default,
   `SUPERSERVE_SANDBOX_TIMEOUT_SECONDS` override) so abandoned sandboxes get reaped; active previews
   live within the window. With option (c), a "deployed" app is sandbox-scoped by design.
7. Residual optional Cloudflare Browser Rendering (hosted API) for screenshot capture; `downloadR2Image`/
   `imageToBase64` remain R2-only (unused on the new stack); the `screenshots` Supabase bucket must be
   created (runbook).

## Live-validation runbook additions (beyond `docs/thin-vertical.md`)
- Create a `screenshots` bucket in the Supabase project; decide + implement the upload-credential design
  (item 1) before screenshots work end-to-end.
- GitHub export/clone: needs a live sandbox with a real `/workspace/.git`; connect a GitHub OAuth app.
- App-details summary/preview: read from `agent_state`/`agent_sessions` — works once a session has run.
- Optional screenshot capture: set `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` in the sandbox env.

## Deferred to Phase 4 (cutover/cleanup)
Delete the Cloudflare `worker/index.ts` entrypoint + wrangler config; rename the still-`cloudflare_deployment_*`
wire message types; remove the now-unused `objective` field in `StandaloneAgent`, the dead
`getAgentStubLightweight`, `DeferredInPhase2aError`, provider CRUD 503 stubs, the `'agent'` ws-ticket branch,
and the unrouted `handleWebSocketConnection`/`deployPreview`.

## Deferred to a dedicated follow-up
The **vault** (`/api/vault/*` ×5 + WS + `codingAgent` `SecretsClient` + `byokHelper`): new `vault_config`
table, ephemeral-key session model (security decision), Realtime WS transport.
