# SuperServe Sandbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SuperServeSandboxService` provider so generated-app preview and deployment run on SuperServe sandboxes instead of Cloudflare Containers / Workers for Platforms, behind `SANDBOX_SERVICE_TYPE=superserve`, with the Cloudflare path untouched for rollback.

**Architecture:** vibesdk already has a provider seam (`BaseSandboxService` + `factory.ts`). We add a third implementation that drives SuperServe via `@superserve/sdk` (control plane `api.superserve.ai` with API key; data plane per-sandbox, auto-resume handled by the SDK). Preview URLs keep the exact `{port}-{sandboxId}-{token}.{previewDomain}` shape; the `{sandboxId}` slot carries the **SuperServe** sandbox id and `{token}` is a 16-hex-char HMAC minted/verified by us (the Cloudflare sandbox DO validated its own token; on SuperServe the Worker is the auth boundary). `request-handler.ts` gains a SuperServe branch that proxies server-side to `https://{port}-{ssid}.{SUPERSERVE_SANDBOX_HOST}`. Deploys create one **always-on** sandbox per app (`bun run preview` under the existing `monitor-cli` harness), with `{deploymentId → sandboxId, port}` persisted in KV (`VibecoderStore`) and resolved by `worker/index.ts` before the dispatcher fallback.

**Tech Stack:** Cloudflare Workers (workerd), TypeScript strict (no `any`), `@superserve/sdk@0.7.7` (zero runtime deps, workerd-compatible — verified), vitest + `@cloudflare/vitest-pool-workers`, bun.

## Global Constraints

- `SANDBOX_SERVICE_TYPE=superserve` selects the provider; any other value must leave behavior byte-for-byte unchanged (PRD acceptance §11.6).
- NEVER use the `any` type (repo CLAUDE.md). Types come from `worker/services/sandbox/sandboxTypes.ts` / `types.ts`.
- One SuperServe sandbox per active chat session, named/keyed by `i-{sessionId}` via sandbox **metadata** (`vibesdk_instance`), one-to-one (PRD decision 7). `ALLOCATION_STRATEGY=many_to_one` is a Cloudflare-only concept — ignored by this provider.
- Deployed apps: one **always-on** sandbox per app — no `timeoutSeconds`, never paused (PRD decision 2). Preview sandboxes get `timeoutSeconds` = `SUPERSERVE_PREVIEW_TIMEOUT_SECONDS` (default 86400) as a leak cap.
- Every `commands.run` MUST pass an explicit `timeoutMs` — the data-plane default is **30 s** (verified in `superserve-ai/sandbox` `cmd/boxd/exec_http.go:56`), which would kill `bun install`.
- Non-zero exit codes are **returned** by the SDK (`CommandResult.exitCode`), not thrown. Transport/auth errors throw (`SandboxError` subclasses). Paused sandboxes auto-resume inside SDK `commands.*`/`files.*` calls; raw `fetch()` to preview ports does NOT auto-resume — our proxy handles 503 itself.
- Long-lived processes must be detached with `setsid … & ` — boxd SIGKILLs the exec's process group on timeout/cancel (`cmd/boxd/main.go:450-455`), and the started command must return immediately.
- SuperServe preview ports are **publicly reachable** on the SuperServe edge by anyone who knows `{port}-{id}` (no token; verified `internal/proxy/proxy.go:162-230`). Our vibesdk-domain token gates the vibesdk proxy only; do not treat it as protecting the SuperServe origin. Never expose `SUPERSERVE_API_KEY` or per-sandbox access tokens to the browser.
- No emojis anywhere. Comments explain purpose, not narration. Follow the sandbox dir's camelCase file naming (`fileTreeBuilder.ts` style).
- Do not run the dev server or build the frontend (user rule). Verification = `bun run typecheck`, `bun run lint`, `bun run test`.
- Commit after every task (conventional commits, no co-author lines).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | modify | add `@superserve/sdk` |
| `wrangler.jsonc` | modify | new `SUPERSERVE_*` vars |
| `worker-configuration.d.ts` | regenerate | `bun run cf-typegen` |
| `.dev.vars.example` | modify | document new secrets/vars |
| `worker/services/sandbox/previewToken.ts` | create | HMAC mint/verify for preview-URL tokens |
| `worker/services/sandbox/bulkFileScript.ts` | create | pure base64 batch-write script builder + result parser (extracted from `sandboxSdkClient.ts:260-349`) |
| `worker/services/sandbox/staticAnalysisParsers.ts` | create | pure ESLint-JSON + tsc-output parsers (extracted from `sandboxSdkClient.ts:1604-1732`) |
| `worker/services/sandbox/sandboxSdkClient.ts` | modify | consume the two extracted modules; export `InstanceMetadata` moved to `types.ts` |
| `worker/services/sandbox/types.ts` | modify | add `InstanceMetadata` (moved), SuperServe DI types |
| `worker/services/sandbox/superServeConfig.ts` | create | env access, egress allowlist, constants, `isSuperServeEnabled` |
| `worker/services/sandbox/superServeSandboxService.ts` | create | the provider (15 abstract methods) |
| `worker/services/sandbox/superServeProxy.ts` | create | target-URL builder, header stripping, 503-resume proxy, deploy-mapping KV |
| `worker/services/sandbox/factory.ts` | modify | `superserve` branch |
| `worker/services/sandbox/request-handler.ts` | modify | delegate to SuperServe proxy when enabled |
| `worker/index.ts` | modify | deployed-app resolution via KV before dispatcher |
| `worker/api/controllers/apps/controller.ts` | modify | best-effort deploy-sandbox kill on app delete |
| `scripts/superserve/build-template.ts` | create | build/rebuild the SuperServe Template from the harness |
| `docs/superserve-sandbox.md` | create | runbook: env, template build, rollout/rollback |
| `test/worker/services/sandbox/*.test.ts` | create | unit tests (workers pool) |

Provider-internal composition: `superServeSandboxService.ts` holds orchestration; every parsable/computable piece (token, script, parsers, target URLs, command builders) lives in the small pure modules so they are unit-testable without mocking the SDK. The provider takes an injectable `SuperServeApi` (defaults to the real SDK classes) so orchestration tests use fakes, not module mocks.

---

### Task 1: Dependency and configuration plumbing

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `wrangler.jsonc` (`vars` block, around line 200 where `TEMPLATES_REPOSITORY`/`DISPATCH_NAMESPACE` live)
- Modify: `.dev.vars.example`
- Regenerate: `worker-configuration.d.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: typed `env.SUPERSERVE_API_KEY`, `env.SUPERSERVE_TEMPLATE`, `env.SUPERSERVE_SANDBOX_HOST`, `env.SUPERSERVE_BASE_URL`, `env.SUPERSERVE_EGRESS_ALLOW`, `env.SUPERSERVE_PREVIEW_TIMEOUT_SECONDS` (all `string`), and the `@superserve/sdk` package for later tasks.

- [ ] **Step 1: Add the dependency (exact version)**

Run: `bun add @superserve/sdk@0.7.7`
Expected: `package.json` gains `"@superserve/sdk": "0.7.7"` and `bun.lock` updates.

- [ ] **Step 2: Add vars to `wrangler.jsonc`**

Inside the existing top-level `"vars"` object (same object that contains `"TEMPLATES_REPOSITORY"` and `"MAX_SANDBOX_INSTANCES"`), add:

```jsonc
        "SUPERSERVE_API_KEY": "",
        "SUPERSERVE_TEMPLATE": "vibesdk-sandbox",
        "SUPERSERVE_SANDBOX_HOST": "sandbox.superserve.ai",
        "SUPERSERVE_BASE_URL": "",
        "SUPERSERVE_EGRESS_ALLOW": "",
        "SUPERSERVE_PREVIEW_TIMEOUT_SECONDS": "86400",
```

`SUPERSERVE_API_KEY` follows the repo's existing pattern for secret-shaped vars (`CLOUDFLARE_API_TOKEN` is also a var with an empty default, overridden as a secret in real deployments).

- [ ] **Step 3: Document in `.dev.vars.example`**

Append:

```
# SuperServe sandbox provider (SANDBOX_SERVICE_TYPE=superserve)
SUPERSERVE_API_KEY=""
SUPERSERVE_TEMPLATE="vibesdk-sandbox"
SUPERSERVE_SANDBOX_HOST="sandbox.superserve.ai"
SUPERSERVE_BASE_URL=""
SUPERSERVE_EGRESS_ALLOW=""
SUPERSERVE_PREVIEW_TIMEOUT_SECONDS="86400"
```

(If `.dev.vars.example` does not exist, check for `.dev.vars.example`/`.env.example` variants with `ls -a | grep -i vars` and append to the one that exists; if none exists, skip this step.)

- [ ] **Step 4: Regenerate worker types**

Run: `bun run cf-typegen`
Expected: `worker-configuration.d.ts` regenerated; `rg -n "SUPERSERVE_API_KEY" worker-configuration.d.ts` shows the six new keys typed as `string`.

- [ ] **Step 5: Verify typecheck and existing tests still pass**

Run: `bun run typecheck && bun run test`
Expected: both green (no source uses the new vars yet).

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock wrangler.jsonc worker-configuration.d.ts .dev.vars.example
git commit -m "chore: add @superserve/sdk and superserve provider config vars"
```

---

### Task 2: Preview token helper (`previewToken.ts`)

The Cloudflare sandbox DO generated and validated its own 16-char port tokens (`sandbox.exposePort` → `{port}-{sandboxId}-{token}` and the DO checks it). On SuperServe the Worker is the boundary, so we mint a deterministic HMAC token and verify it in the proxy. Hex output (`[0-9a-f]{16}`) is a strict subset of the route regex charset `[a-z0-9_-]{16}` in `request-handler.ts:99`, so URL parsing is unchanged.

**Files:**
- Create: `worker/services/sandbox/previewToken.ts`
- Test: `test/worker/services/sandbox/previewToken.test.ts`

**Interfaces:**
- Consumes: WebCrypto (`crypto.subtle`, available in workerd).
- Produces:
  - `mintPreviewToken(secret: string, port: number, sandboxId: string): Promise<string>` — 16 lowercase hex chars, deterministic.
  - `verifyPreviewToken(secret: string, port: number, sandboxId: string, token: string): Promise<boolean>` — constant-time-ish compare.

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/previewToken.test.ts
import { describe, expect, it } from 'vitest';
import { mintPreviewToken, verifyPreviewToken } from 'worker/services/sandbox/previewToken';

const SECRET = 'test-secret-value';

describe('previewToken', () => {
    it('mints a 16-char token matching the preview route charset', async () => {
        const token = await mintPreviewToken(SECRET, 8080, '2b7e1c1e-9d1c-4a7b-b1e0-1f2e3d4c5b6a');
        expect(token).toMatch(/^[a-z0-9_-]{16}$/);
        expect(token).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic for the same inputs', async () => {
        const a = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        const b = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        expect(a).toBe(b);
    });

    it('verifies a minted token', async () => {
        const token = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-a', token)).toBe(true);
    });

    it('rejects a token minted for a different port, sandbox, or secret', async () => {
        const token = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        expect(await verifyPreviewToken(SECRET, 8081, 'sandbox-a', token)).toBe(false);
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-b', token)).toBe(false);
        expect(await verifyPreviewToken('other-secret', 8080, 'sandbox-a', token)).toBe(false);
    });

    it('rejects malformed tokens without throwing', async () => {
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-a', '')).toBe(false);
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-a', 'zzzzzzzzzzzzzzzz')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/worker/services/sandbox/previewToken.test.ts`
Expected: FAIL — cannot resolve `worker/services/sandbox/previewToken`.

- [ ] **Step 3: Write the implementation**

```ts
// worker/services/sandbox/previewToken.ts
/**
 * Deterministic HMAC tokens for SuperServe preview URLs.
 *
 * The Cloudflare sandbox validates its own exposePort tokens inside the
 * Durable Object; for SuperServe the Worker is the auth boundary, so preview
 * URLs carry HMAC-SHA256(secret, "superserve-preview:{port}:{sandboxId}")
 * truncated to 16 hex chars — a subset of the existing route token charset.
 */

const TOKEN_LENGTH = 16;

async function hmacHex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function mintPreviewToken(secret: string, port: number, sandboxId: string): Promise<string> {
    const digest = await hmacHex(secret, `superserve-preview:${port}:${sandboxId}`);
    return digest.slice(0, TOKEN_LENGTH);
}

export async function verifyPreviewToken(
    secret: string,
    port: number,
    sandboxId: string,
    token: string,
): Promise<boolean> {
    if (token.length !== TOKEN_LENGTH) {
        return false;
    }
    const expected = await mintPreviewToken(secret, port, sandboxId);
    let mismatch = 0;
    for (let i = 0; i < TOKEN_LENGTH; i++) {
        mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return mismatch === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/worker/services/sandbox/previewToken.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/services/sandbox/previewToken.ts test/worker/services/sandbox/previewToken.test.ts
git commit -m "feat: add HMAC preview token helper for superserve preview URLs"
```

---

### Task 3: Extract shared pure helpers from the Cloudflare client

`sandboxSdkClient.ts` contains two provider-agnostic pieces the SuperServe provider needs verbatim: the base64 batch-write script builder (`writeFilesViaScript`, lines 260-349) and the ESLint/tsc output parsers (`runStaticAnalysisCode`, lines 1604-1732). Extract them as pure functions, refactor the Cloudflare client to call them (behavior-preserving move), and unit-test them. Also move the private `InstanceMetadata` interface (lines 54-64) to `types.ts` so both providers share it.

**Files:**
- Create: `worker/services/sandbox/bulkFileScript.ts`
- Create: `worker/services/sandbox/staticAnalysisParsers.ts`
- Modify: `worker/services/sandbox/sandboxSdkClient.ts` (delete moved code, import the new modules)
- Modify: `worker/services/sandbox/types.ts` (add `InstanceMetadata`)
- Test: `test/worker/services/sandbox/bulkFileScript.test.ts`
- Test: `test/worker/services/sandbox/staticAnalysisParsers.test.ts`

**Interfaces:**
- Consumes: `CodeIssue`, `LintSeverity` from `./sandboxTypes` (existing), `TemplateFile` from `./sandboxTypes`.
- Produces (exact signatures later tasks rely on):
  - `buildBulkWriteScript(files: Array<{ filePath: string; fileContents: string }>): string`
  - `parseBulkWriteOutput(files: Array<{ filePath: string }>, output: string): Array<{ file: string; success: boolean; error?: string }>`
  - `parseESLintJson(stdout: string): CodeIssue[]`
  - `parseTscOutput(output: string): CodeIssue[]`
  - `summarizeIssues(issues: CodeIssue[]): { errorCount: number; warningCount: number; infoCount: number }`
  - `interface InstanceMetadata` in `types.ts`: `{ projectName: string; startTime: string; webhookUrl?: string; previewURL?: string; tunnelURL?: string; processId?: string; allocatedPort?: number; donttouch_files: string[]; redacted_files: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/worker/services/sandbox/bulkFileScript.test.ts
import { describe, expect, it } from 'vitest';
import { buildBulkWriteScript, parseBulkWriteOutput } from 'worker/services/sandbox/bulkFileScript';

describe('buildBulkWriteScript', () => {
    it('emits one decode line per file with base64 round-trippable content', () => {
        const files = [
            { filePath: '/workspace/i-1/src/index.ts', fileContents: 'const x = "hello \'world\'";\n' },
            { filePath: '/workspace/i-1/README.md', fileContents: 'unicode: é—你好' },
        ];
        const script = buildBulkWriteScript(files);
        expect(script.startsWith('#!/bin/bash')).toBe(true);
        for (const { filePath, fileContents } of files) {
            const line = script.split('\n').find((l) => l.includes(filePath));
            expect(line).toBeDefined();
            const b64 = /echo '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(line ?? '')?.[1] ?? '';
            const decoded = new TextDecoder().decode(
                Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
            );
            expect(decoded).toBe(fileContents);
        }
    });

    it('returns an empty-script guard for zero files', () => {
        expect(buildBulkWriteScript([])).toBe('#!/bin/bash');
    });
});

describe('parseBulkWriteOutput', () => {
    it('maps OK markers to success and missing markers to failure', () => {
        const files = [{ filePath: '/a/one.ts' }, { filePath: '/a/two.ts' }];
        const output = 'OK:/a/one.ts\nFAIL:/a/two.ts\n';
        expect(parseBulkWriteOutput(files, output)).toEqual([
            { file: '/a/one.ts', success: true, error: undefined },
            { file: '/a/two.ts', success: false, error: 'Write failed' },
        ]);
    });
});
```

```ts
// test/worker/services/sandbox/staticAnalysisParsers.test.ts
import { describe, expect, it } from 'vitest';
import {
    parseESLintJson,
    parseTscOutput,
    summarizeIssues,
} from 'worker/services/sandbox/staticAnalysisParsers';

describe('parseESLintJson', () => {
    it('flattens files/messages and maps severities', () => {
        const stdout = JSON.stringify([
            {
                filePath: 'src/App.tsx',
                messages: [
                    { message: 'Unexpected var', line: 3, column: 5, severity: 2, ruleId: 'no-var' },
                    { message: 'Prefer const', line: 9, column: 1, severity: 1, ruleId: 'prefer-const' },
                ],
            },
        ]);
        const issues = parseESLintJson(stdout);
        expect(issues).toHaveLength(2);
        expect(issues[0]).toMatchObject({
            filePath: 'src/App.tsx', line: 3, severity: 'error', ruleId: 'no-var', source: 'eslint',
        });
        expect(issues[1].severity).toBe('warning');
    });

    it('returns [] on non-JSON output', () => {
        expect(parseESLintJson('eslint blew up')).toEqual([]);
    });
});

describe('parseTscOutput', () => {
    it('parses file(line,col): error TSxxxx: message lines with continuations', () => {
        const output = [
            "src/main.ts(10,5): error TS2322: Type 'string' is not assignable",
            "  to type 'number'.",
            'src/other.ts(1,1): error TS1005: expected.',
        ].join('\n');
        const issues = parseTscOutput(output);
        expect(issues).toHaveLength(2);
        expect(issues[0]).toMatchObject({
            filePath: 'src/main.ts', line: 10, column: 5, ruleId: 'TS2322', severity: 'error', source: 'typescript',
        });
        expect(issues[0].message).toContain("to type 'number'.");
    });

    it('returns [] for empty output', () => {
        expect(parseTscOutput('')).toEqual([]);
    });
});

describe('summarizeIssues', () => {
    it('counts by severity', () => {
        const issues = parseTscOutput("a.ts(1,1): error TS1: x.\n");
        expect(summarizeIssues(issues)).toEqual({ errorCount: 1, warningCount: 0, infoCount: 0 });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- test/worker/services/sandbox/bulkFileScript.test.ts test/worker/services/sandbox/staticAnalysisParsers.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Create `bulkFileScript.ts`** (logic moved verbatim from `sandboxSdkClient.ts:268-296` and `309-321`)

```ts
// worker/services/sandbox/bulkFileScript.ts
/**
 * Builds a single bash script that writes N files via base64 heredoc lines.
 * Reduces 2N data-plane round trips to two (write script + execute), which
 * both the Cloudflare and SuperServe providers rely on for bulk writes.
 */

export function buildBulkWriteScript(
    files: Array<{ filePath: string; fileContents: string }>,
): string {
    const scriptLines = ['#!/bin/bash'];

    for (const { filePath, fileContents } of files) {
        const utf8Bytes = new TextEncoder().encode(fileContents);
        const chunkSize = 8192;
        const base64Chunks: string[] = [];

        for (let i = 0; i < utf8Bytes.length; i += chunkSize) {
            const chunk = utf8Bytes.slice(i, i + chunkSize);
            let binaryString = '';
            for (let j = 0; j < chunk.length; j++) {
                binaryString += String.fromCharCode(chunk[j]);
            }
            base64Chunks.push(btoa(binaryString));
        }

        const base64 = base64Chunks.join('');
        scriptLines.push(
            `mkdir -p "$(dirname "${filePath}")" && echo '${base64}' | base64 -d > "${filePath}" && echo "OK:${filePath}" || echo "FAIL:${filePath}"`,
        );
    }

    return scriptLines.join('\n');
}

export function parseBulkWriteOutput(
    files: Array<{ filePath: string }>,
    output: string,
): Array<{ file: string; success: boolean; error?: string }> {
    const successPaths = new Set<string>();
    for (const match of output.matchAll(/OK:(.+)/g)) {
        if (match[1]) successPaths.add(match[1]);
    }
    return files.map(({ filePath }) => ({
        file: filePath,
        success: successPaths.has(filePath),
        error: successPaths.has(filePath) ? undefined : 'Write failed',
    }));
}
```

- [ ] **Step 4: Create `staticAnalysisParsers.ts`** (logic moved verbatim from `sandboxSdkClient.ts:1604-1732`)

```ts
// worker/services/sandbox/staticAnalysisParsers.ts
import { CodeIssue, LintSeverity } from './sandboxTypes';

function mapESLintSeverity(severity: number): LintSeverity {
    switch (severity) {
        case 1: return 'warning';
        case 2: return 'error';
        default: return 'info';
    }
}

export function parseESLintJson(stdout: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    try {
        const lintData = JSON.parse(stdout) as Array<{
            filePath: string;
            messages: Array<{
                message: string;
                line?: number;
                column?: number;
                severity: number;
                ruleId?: string;
            }>;
        }>;
        for (const fileResult of lintData) {
            for (const message of fileResult.messages || []) {
                issues.push({
                    message: message.message,
                    filePath: fileResult.filePath,
                    line: message.line || 0,
                    column: message.column,
                    severity: mapESLintSeverity(message.severity),
                    ruleId: message.ruleId || '',
                    source: 'eslint',
                });
            }
        }
    } catch {
        return [];
    }
    return issues;
}

export function parseTscOutput(output: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    if (!output || output.trim() === '') {
        return issues;
    }
    let currentError: CodeIssue | null = null;
    for (const line of output.split('\n')) {
        const match = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
        if (match) {
            if (currentError) {
                issues.push(currentError);
            }
            currentError = {
                message: match[5].trim(),
                filePath: match[1].trim(),
                line: parseInt(match[2]),
                column: parseInt(match[3]),
                severity: 'error',
                source: 'typescript',
                ruleId: `TS${match[4]}`,
            };
        } else if (currentError && line.trim() && !line.startsWith('src/') && !line.includes(': error TS')) {
            currentError.message += ' ' + line.trim();
        }
    }
    if (currentError) {
        issues.push(currentError);
    }
    return issues;
}

export function summarizeIssues(issues: CodeIssue[]): {
    errorCount: number;
    warningCount: number;
    infoCount: number;
} {
    return {
        errorCount: issues.filter((issue) => issue.severity === 'error').length,
        warningCount: issues.filter((issue) => issue.severity === 'warning').length,
        infoCount: issues.filter((issue) => issue.severity === 'info').length,
    };
}
```

Note: `CodeIssue` in `sandboxTypes.ts` must structurally allow `column?: number` and `source: string` — check the existing interface (`rg -n "interface CodeIssue" worker/services/sandbox/sandboxTypes.ts`) and match its exact field names; the code above mirrors what `sandboxSdkClient.ts` already constructs, so no type changes should be needed.

- [ ] **Step 5: Move `InstanceMetadata` to `types.ts`**

In `worker/services/sandbox/types.ts` add (and export):

```ts
export interface InstanceMetadata {
    projectName: string;
    startTime: string;
    webhookUrl?: string;
    previewURL?: string;
    tunnelURL?: string;
    processId?: string;
    allocatedPort?: number;
    donttouch_files: string[];
    redacted_files: string[];
}
```

In `sandboxSdkClient.ts` delete the private `interface InstanceMetadata` (lines 54-64) and add `InstanceMetadata` to the existing `import { ResourceProvisioningResult } from './types';` line.

- [ ] **Step 6: Refactor `sandboxSdkClient.ts` to consume the extracted modules**

In `writeFilesViaScript` (lines 260-349): replace the inline script generation (lines 268-296) with `const script = buildBulkWriteScript(files);` and the inline OK-marker parsing (lines 309-321) with `const results = parseBulkWriteOutput(files, output);`. Keep the logging, `/tmp/batch_write.sh` write, and `bash` exec exactly as they are.

In `runStaticAnalysisCode` (lines 1571-1724): replace the inline ESLint parsing block with `const lintIssues = parseESLintJson(lintResult.value.stdout);`, the inline tsc parsing block with `const typecheckIssues = parseTscOutput(tscResult.value.stderr || tscResult.value.stdout);`, and both summary computations with `summarizeIssues(lintIssues)` / `summarizeIssues(typecheckIssues)`. Delete the now-unused private `mapESLintSeverity` (lines 1726-1732). Keep `rawOutput` assembly and all logging unchanged.

Imports to add at the top of `sandboxSdkClient.ts`:

```ts
import { buildBulkWriteScript, parseBulkWriteOutput } from './bulkFileScript';
import { parseESLintJson, parseTscOutput, summarizeIssues } from './staticAnalysisParsers';
```

- [ ] **Step 7: Run tests and typecheck**

Run: `bun run typecheck && bun run test -- test/worker/services/sandbox/`
Expected: typecheck green; new tests PASS; no other test regressions (`bun run test` full run also green).

- [ ] **Step 8: Commit**

```bash
git add worker/services/sandbox/bulkFileScript.ts worker/services/sandbox/staticAnalysisParsers.ts worker/services/sandbox/sandboxSdkClient.ts worker/services/sandbox/types.ts test/worker/services/sandbox/
git commit -m "refactor: extract bulk write script and static analysis parsers from sandboxSdkClient"
```

---

### Task 4: SuperServe config module and provider scaffold

**Files:**
- Create: `worker/services/sandbox/superServeConfig.ts`
- Create: `worker/services/sandbox/superServeSandboxService.ts` (scaffold: DI types, constructor, sandbox resolution, shell helpers, `initialize`)
- Test: `test/worker/services/sandbox/superServeConfig.test.ts`

**Interfaces:**
- Consumes: `env` from `cloudflare:workers`; `Sandbox`, `Template`, `SandboxInfo`, `SandboxCreateOptions`, `SandboxListOptions`, `ConnectionOptions`, `CommandResult` from `@superserve/sdk`; `BaseSandboxService` (constructor `super(sandboxId)`).
- Produces (used by Tasks 5-10):
  - `isSuperServeEnabled(env: Env): boolean`
  - `superServeConnection(env: Env): { apiKey: string; baseUrl?: string }` — throws if `SUPERSERVE_API_KEY` missing
  - `buildEgressAllowlist(env: Env): string[]`
  - `previewTimeoutSeconds(env: Env): number | undefined`
  - `shellQuote(value: string): string`
  - `buildSupervisorStartCommand(instanceId: string, initCommand: string, port: number): string`
  - Constants: `DEV_SERVER_PORT = 8080`, `INSTALL_TIMEOUT_MS = 300_000`, `COMMAND_TIMEOUT_MS = 60_000`, `QUICK_TIMEOUT_MS = 15_000`
  - `class SuperServeSandboxService extends BaseSandboxService` with `constructor(sandboxId: string, agentId: string, api?: SuperServeApi)`
  - `interface SuperServeApi { create(o: SandboxCreateOptions): Promise<SuperServeSandboxHandle>; connect(id: string, o: ConnectionOptions): Promise<SuperServeSandboxHandle>; list(o: SandboxListOptions): Promise<SandboxInfo[]>; killById(id: string, o: ConnectionOptions): Promise<void>; connectTemplate(nameOrId: string, o: ConnectionOptions): Promise<unknown>; }` (in `types.ts`)
  - `type SuperServeSandboxHandle = Pick<Sandbox, 'id' | 'name' | 'status' | 'metadata' | 'commands' | 'files' | 'getInfo' | 'pause' | 'resume' | 'kill' | 'update'>` (in `types.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/superServeConfig.test.ts
import { describe, expect, it } from 'vitest';
import {
    buildEgressAllowlistFrom,
    buildSupervisorStartCommand,
    shellQuote,
} from 'worker/services/sandbox/superServeConfig';

describe('shellQuote', () => {
    it('wraps in single quotes and escapes embedded single quotes', () => {
        expect(shellQuote('plain')).toBe("'plain'");
        expect(shellQuote("it's")).toBe("'it'\\''s'");
    });
});

describe('buildSupervisorStartCommand', () => {
    it('detaches the harness supervisor with setsid/nohup and echoes the pid', () => {
        const cmd = buildSupervisorStartCommand('i-abc', 'bun run dev', 8080);
        expect(cmd).toContain('setsid nohup sh -c ');
        expect(cmd).toContain('VITE_LOGGER_TYPE=json PORT=8080 monitor-cli process start --instance-id i-abc --port 8080 -- bun run dev');
        expect(cmd).toContain('> /workspace/data/i-abc-supervisor.log 2>&1 < /dev/null &');
        expect(cmd.trim().endsWith('echo $!')).toBe(true);
    });
});

describe('buildEgressAllowlistFrom', () => {
    it('includes registries, github, AI providers, own domains, and extras without duplicates', () => {
        const list = buildEgressAllowlistFrom('example.com', 'preview.example.com', 'extra.dev, extra.dev');
        expect(list).toContain('registry.npmjs.org');
        expect(list).toContain('github.com');
        expect(list).toContain('api.anthropic.com');
        expect(list).toContain('example.com');
        expect(list).toContain('preview.example.com');
        expect(list.filter((h) => h === 'extra.dev')).toHaveLength(1);
    });

    it('tolerates missing domains and empty extras', () => {
        const list = buildEgressAllowlistFrom('', '', '');
        expect(list.length).toBeGreaterThan(5);
        expect(list).not.toContain('');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/worker/services/sandbox/superServeConfig.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `superServeConfig.ts`**

```ts
// worker/services/sandbox/superServeConfig.ts
import { env } from 'cloudflare:workers';
import { getPreviewDomain } from '../../utils/urls';

export const DEV_SERVER_PORT = 8080;
export const INSTALL_TIMEOUT_MS = 300_000;
export const COMMAND_TIMEOUT_MS = 60_000;
export const QUICK_TIMEOUT_MS = 15_000;

/** Hostnames generated apps legitimately need: package registries, source hosts, AI providers. */
const DEFAULT_EGRESS_ALLOW = [
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'bun.sh',
    'github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'openrouter.ai',
    'api.cerebras.ai',
    'api.groq.com',
    'gateway.ai.cloudflare.com',
    'esm.sh',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'images.unsplash.com',
];

export function isSuperServeEnabled(e: typeof env): boolean {
    return e.SANDBOX_SERVICE_TYPE === 'superserve';
}

export function superServeConnection(e: typeof env): { apiKey: string; baseUrl?: string } {
    const apiKey = e.SUPERSERVE_API_KEY;
    if (!apiKey) {
        throw new Error('SUPERSERVE_API_KEY is not configured but SANDBOX_SERVICE_TYPE=superserve');
    }
    const baseUrl = e.SUPERSERVE_BASE_URL;
    return baseUrl ? { apiKey, baseUrl } : { apiKey };
}

export function superServeSandboxHost(e: typeof env): string {
    return e.SUPERSERVE_SANDBOX_HOST || 'sandbox.superserve.ai';
}

/** Pure core, unit-testable without env. */
export function buildEgressAllowlistFrom(
    customDomain: string,
    previewDomain: string,
    extraCsv: string,
): string[] {
    const extras = extraCsv.split(',').map((s) => s.trim()).filter(Boolean);
    const own = [customDomain, previewDomain].filter(Boolean);
    return [...new Set([...DEFAULT_EGRESS_ALLOW, ...own, ...extras])];
}

export function buildEgressAllowlist(e: typeof env): string[] {
    return buildEgressAllowlistFrom(
        e.CUSTOM_DOMAIN ?? '',
        getPreviewDomain(e) ?? '',
        e.SUPERSERVE_EGRESS_ALLOW ?? '',
    );
}

export function previewTimeoutSeconds(e: typeof env): number | undefined {
    const raw = Number(e.SUPERSERVE_PREVIEW_TIMEOUT_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Starts the monitor-cli supervisor fully detached so it outlives the exec:
 * boxd runs each exec in its own process group and SIGKILLs the group on
 * timeout, so the supervisor must escape into a new session (setsid) with
 * stdio redirected, and the exec returns immediately with the pid.
 */
export function buildSupervisorStartCommand(instanceId: string, initCommand: string, port: number): string {
    const supervised = `VITE_LOGGER_TYPE=json PORT=${port} monitor-cli process start --instance-id ${instanceId} --port ${port} -- ${initCommand}`;
    const log = `/workspace/data/${instanceId}-supervisor.log`;
    return `mkdir -p /workspace/data && setsid nohup sh -c ${shellQuote(supervised)} > ${log} 2>&1 < /dev/null & echo $!`;
}
```

Check the exact export name of `getPreviewDomain` in `worker/utils/urls.ts` (it exists — used by `sandboxSdkClient.ts:46`). If `getPreviewDomain` returns `string` (not `string | undefined`), drop the `?? ''`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/worker/services/sandbox/superServeConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Add DI types to `types.ts`**

Append to `worker/services/sandbox/types.ts`:

```ts
import type {
    ConnectionOptions,
    Sandbox as SuperServeSdkSandbox,
    SandboxCreateOptions,
    SandboxInfo,
    SandboxListOptions,
} from '@superserve/sdk';

/** Narrow handle so tests can fake the SDK without module mocks. */
export type SuperServeSandboxHandle = Pick<
    SuperServeSdkSandbox,
    'id' | 'name' | 'status' | 'metadata' | 'commands' | 'files' | 'getInfo' | 'pause' | 'resume' | 'kill' | 'update'
>;

export interface SuperServeApi {
    create(options: SandboxCreateOptions): Promise<SuperServeSandboxHandle>;
    connect(sandboxId: string, options: ConnectionOptions): Promise<SuperServeSandboxHandle>;
    list(options: SandboxListOptions): Promise<SandboxInfo[]>;
    killById(sandboxId: string, options: ConnectionOptions): Promise<void>;
    /** Used by initialize() to validate auth + template existence. */
    connectTemplate(nameOrId: string, options: ConnectionOptions): Promise<unknown>;
}
```

(If the SDK type import names differ, `rg -n "export (interface|type) Sandbox(CreateOptions|ListOptions|Info)" node_modules/@superserve/sdk/dist/index.d.ts` and use the exact exported names.)

- [ ] **Step 6: Write the provider scaffold**

```ts
// worker/services/sandbox/superServeSandboxService.ts
import { Sandbox as SuperServeSandbox, Template as SuperServeTemplate } from '@superserve/sdk';
import { env } from 'cloudflare:workers';
import { BaseSandboxService } from './BaseSandboxService';
import { createObjectLogger } from '../../logger';
import { InstanceMetadata, SuperServeApi, SuperServeSandboxHandle } from './types';
import {
    COMMAND_TIMEOUT_MS,
    QUICK_TIMEOUT_MS,
    superServeConnection,
} from './superServeConfig';

/** Default API adapter over the real SDK; tests inject a fake. */
const sdkApi: SuperServeApi = {
    create: (options) => SuperServeSandbox.create(options),
    connect: (sandboxId, options) => SuperServeSandbox.connect(sandboxId, options),
    list: (options) => SuperServeSandbox.list(options),
    killById: (sandboxId, options) => SuperServeSandbox.killById(sandboxId, options),
    connectTemplate: (nameOrId, options) => SuperServeTemplate.connect(nameOrId, options),
};

export class SuperServeSandboxService extends BaseSandboxService {
    private readonly api: SuperServeApi;
    private readonly agentId: string;
    private sandboxCache = new Map<string, SuperServeSandboxHandle>();

    constructor(sandboxId: string, agentId: string, api: SuperServeApi = sdkApi) {
        super(sandboxId);
        this.api = api;
        this.agentId = agentId;
        this.logger = createObjectLogger(this, 'SuperServeSandboxService');
        this.logger.setFields({ sandboxId: this.sandboxId, agentId });
    }

    async initialize(): Promise<void> {
        // Validates control-plane auth and that the configured template exists.
        await this.api.connectTemplate(env.SUPERSERVE_TEMPLATE, superServeConnection(env));
        this.logger.info('SuperServe control plane reachable', { template: env.SUPERSERVE_TEMPLATE });
    }

    /** One sandbox per session (PRD decision 7). */
    protected instanceIdForSession(): string {
        return `i-${this.sandboxId}`;
    }

    protected instanceDir(instanceId: string): string {
        return `/workspace/${instanceId}`;
    }

    protected metadataPath(instanceId: string): string {
        return `/workspace/${instanceId}-metadata.json`;
    }

    protected async findSandbox(instanceId: string): Promise<SuperServeSandboxHandle | null> {
        const cached = this.sandboxCache.get(instanceId);
        if (cached) return cached;
        const matches = await this.api.list({
            ...superServeConnection(env),
            metadata: { vibesdk_instance: instanceId },
        });
        if (matches.length === 0) return null;
        const sandbox = await this.api.connect(matches[0].id, superServeConnection(env));
        this.sandboxCache.set(instanceId, sandbox);
        return sandbox;
    }

    protected async requireSandbox(instanceId: string): Promise<SuperServeSandboxHandle> {
        const sandbox = await this.findSandbox(instanceId);
        if (!sandbox) {
            throw new Error(`No SuperServe sandbox found for instance ${instanceId}`);
        }
        return sandbox;
    }

    /** All harness/app commands run inside the instance dir with explicit timeouts. */
    protected async runInInstance(
        sandbox: SuperServeSandboxHandle,
        instanceId: string,
        command: string,
        timeoutMs: number = COMMAND_TIMEOUT_MS,
    ) {
        return sandbox.commands.run(command, { cwd: this.instanceDir(instanceId), timeoutMs });
    }

    protected async readInstanceMetadata(
        sandbox: SuperServeSandboxHandle,
        instanceId: string,
    ): Promise<InstanceMetadata> {
        const raw = await sandbox.files.readText(this.metadataPath(instanceId), { timeoutMs: QUICK_TIMEOUT_MS });
        return JSON.parse(raw) as InstanceMetadata;
    }

    protected async writeInstanceMetadata(
        sandbox: SuperServeSandboxHandle,
        instanceId: string,
        metadata: InstanceMetadata,
    ): Promise<void> {
        await sandbox.files.write(this.metadataPath(instanceId), JSON.stringify(metadata, null, 2), {
            timeoutMs: QUICK_TIMEOUT_MS,
        });
    }

    // Abstract methods are implemented in Tasks 5-7. Until then, satisfy the
    // compiler with explicit not-implemented stubs that are replaced next task.
}
```

For this task only, add temporary stubs for the 14 remaining abstract methods so `tsc` passes, each `throw new Error('SuperServeSandboxService.<method> not implemented yet');` with the exact base-class signature (copy signatures from `BaseSandboxService.ts:220-312`). Tasks 5-7 replace every stub — none may survive to Task 12.

- [ ] **Step 7: Typecheck and run the new tests**

Run: `bun run typecheck && bun run test -- test/worker/services/sandbox/superServeConfig.test.ts`
Expected: green. (`files.readText`/`files.write` accept an options object with `timeoutMs` — verified in SDK `files.ts`; if typecheck disagrees, check `node_modules/@superserve/sdk/dist/index.d.ts` for the exact option name.)

- [ ] **Step 8: Commit**

```bash
git add worker/services/sandbox/superServeConfig.ts worker/services/sandbox/superServeSandboxService.ts worker/services/sandbox/types.ts test/worker/services/sandbox/superServeConfig.test.ts
git commit -m "feat: superserve provider scaffold, config helpers, and DI seam"
```

---

### Task 5: Instance lifecycle — createInstance, status, details, list, shutdown, rename

**Files:**
- Modify: `worker/services/sandbox/superServeSandboxService.ts`
- Test: `test/worker/services/sandbox/superServeLifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2 (`mintPreviewToken`), Task 3 (`buildBulkWriteScript`, `parseBulkWriteOutput`, `InstanceMetadata`), Task 4 (config + scaffold helpers).
- Produces: working `createInstance(options: InstanceCreationRequest): Promise<BootstrapResponse>`, `getInstanceStatus`, `getInstanceDetails`, `listAllInstances`, `shutdownInstance`, `updateProjectName`; internal helpers `writeFilesToSandbox`, `startSupervisedProcess`, `waitForServerReady`, `buildSuperServePreviewUrl(port: number, superServeSandboxId: string): Promise<string>` used by Task 7.

Key behaviors (mirroring `sandboxSdkClient.ts` semantics):
- `createInstance` reuses a healthy existing sandbox for the same instance (parity with `sandboxSdkClient.ts:996-1018`), otherwise kills and recreates.
- The preview URL embeds the **SuperServe sandbox id**, not the vibesdk instance id: `https://{port}-{ssid}-{hmac}.{previewDomain}`. Trade-off (documented in `docs/superserve-sandbox.md`, Task 11): a user who extracts the ssid can hit `{port}-{ssid}.{SUPERSERVE_SANDBOX_HOST}` directly, bypassing vibesdk header-stripping — same trust level as today's CF token-in-URL, accepted for v1.
- Readiness polling reuses the harness log store with the same `readinessPatterns` as `sandboxSdkClient.ts:582-589`.

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/superServeLifecycle.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SuperServeSandboxService } from 'worker/services/sandbox/superServeSandboxService';
import type { SuperServeApi, SuperServeSandboxHandle } from 'worker/services/sandbox/types';

type RunCall = { command: string; options?: { cwd?: string; timeoutMs?: number } };

function fakeSandbox(overrides: Partial<Record<string, unknown>> = {}): {
    handle: SuperServeSandboxHandle;
    runCalls: RunCall[];
    writtenFiles: Map<string, string>;
} {
    const runCalls: RunCall[] = [];
    const writtenFiles = new Map<string, string>();
    const responders: Array<(cmd: string) => { stdout: string; stderr: string; exitCode: number } | null> = [
        (cmd) => (cmd.includes('monitor-cli logs get') ? { stdout: 'VITE ready in 300 ms\nLocal: http://localhost:8080/', stderr: '', exitCode: 0 } : null),
        (cmd) => (cmd.includes('echo $!') ? { stdout: '4242\n', stderr: '', exitCode: 0 } : null),
    ];
    const handle = {
        id: 'ss-sandbox-id-1',
        name: 'i-session-1',
        status: 'active',
        metadata: {},
        commands: {
            run: vi.fn(async (command: string, options?: { cwd?: string; timeoutMs?: number }) => {
                runCalls.push({ command, options });
                for (const responder of responders) {
                    const hit = responder(command);
                    if (hit) return hit;
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
        },
        files: {
            write: vi.fn(async (path: string, content: string) => { writtenFiles.set(path, content); }),
            readText: vi.fn(async (path: string) => {
                const hit = writtenFiles.get(path);
                if (hit === undefined) throw new Error(`no file ${path}`);
                return hit;
            }),
            read: vi.fn(async () => new Uint8Array()),
            downloadDir: vi.fn(async () => new Uint8Array()),
        },
        getInfo: vi.fn(async () => ({ id: 'ss-sandbox-id-1', name: 'i-session-1', status: 'active', vcpuCount: 4, memoryMib: 8192, createdAt: new Date('2026-07-07T00:00:00Z'), metadata: { vibesdk_instance: 'i-session-1' } })),
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        kill: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        ...overrides,
    } as unknown as SuperServeSandboxHandle;
    return { handle, runCalls, writtenFiles };
}

function fakeApi(sandbox: SuperServeSandboxHandle, listResults: Array<{ id: string }> = []): SuperServeApi {
    return {
        create: vi.fn(async () => sandbox),
        connect: vi.fn(async () => sandbox),
        list: vi.fn(async () => listResults as never),
        killById: vi.fn(async () => {}),
        connectTemplate: vi.fn(async () => ({})),
    };
}

describe('SuperServeSandboxService.createInstance', () => {
    it('creates a sandbox, writes files, installs deps, starts the supervisor detached, and returns a tokenized preview URL', async () => {
        const { handle, runCalls, writtenFiles } = fakeSandbox();
        const api = fakeApi(handle);
        const service = new SuperServeSandboxService('session-1', 'agent-1', api);

        const result = await service.createInstance({
            files: [
                { filePath: 'package.json', fileContents: '{"name":"app"}' },
                { filePath: '.donttouch_files.json', fileContents: '["wrangler.jsonc"]' },
            ],
            projectName: 'my-app',
            envVars: { FOO: 'bar' },
            initCommand: 'bun run dev',
        });

        expect(result.success).toBe(true);
        expect(result.runId).toBe('i-session-1');
        expect(result.processId).toBe('4242');
        // Preview URL: {port}-{superserve id}-{16 hex}.{preview domain}
        expect(result.previewURL).toMatch(/^https?:\/\/8080-ss-sandbox-id-1-[0-9a-f]{16}\./);

        expect(api.create).toHaveBeenCalledOnce();
        const createOptions = (api.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(createOptions.metadata.vibesdk_instance).toBe('i-session-1');
        expect(createOptions.metadata.vibesdk_kind).toBe('preview');
        expect(createOptions.network.allowOut).toContain('registry.npmjs.org');

        const installCall = runCalls.find((c) => c.command === 'bun install');
        expect(installCall?.options?.timeoutMs).toBe(300_000);
        expect(runCalls.some((c) => c.command.includes('setsid nohup'))).toBe(true);
        expect(writtenFiles.get('/workspace/i-session-1/.dev.vars')).toBe('FOO=bar');
        expect(writtenFiles.get('/workspace/i-session-1-metadata.json')).toContain('"projectName": "my-app"');
    });

    it('returns the existing instance when one is already healthy', async () => {
        const { handle, writtenFiles } = fakeSandbox();
        writtenFiles.set('/workspace/i-session-1-metadata.json', JSON.stringify({
            projectName: 'my-app', startTime: '2026-07-07T00:00:00Z', previewURL: 'https://8080-ss-sandbox-id-1-abcdefabcdefabcd.p.example.com',
            processId: '4242', allocatedPort: 8080, donttouch_files: [], redacted_files: [],
        }));
        // process status probe reports an active process
        (handle.commands.run as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
            if (command.includes('monitor-cli process status')) {
                return { stdout: JSON.stringify({ success: true, activeProcesses: 1, processes: [{ id: 'p1', state: 'running' }] }), stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        });
        const api = fakeApi(handle, [{ id: 'ss-sandbox-id-1' }]);
        const service = new SuperServeSandboxService('session-1', 'agent-1', api);

        const result = await service.createInstance({ files: [], projectName: 'my-app', initCommand: 'bun run dev' });

        expect(result.success).toBe(true);
        expect(api.create).not.toHaveBeenCalled();
        expect(result.previewURL).toContain('8080-ss-sandbox-id-1');
    });
});

describe('SuperServeSandboxService.shutdownInstance', () => {
    it('pauses the sandbox and reports success', async () => {
        const { handle } = fakeSandbox();
        const api = fakeApi(handle, [{ id: 'ss-sandbox-id-1' }]);
        const service = new SuperServeSandboxService('session-1', 'agent-1', api);
        const result = await service.shutdownInstance('i-session-1');
        expect(result.success).toBe(true);
        expect(handle.pause).toHaveBeenCalledOnce();
    });

    it('is idempotent when no sandbox exists', async () => {
        const { handle } = fakeSandbox();
        const api = fakeApi(handle, []);
        const service = new SuperServeSandboxService('session-1', 'agent-1', api);
        const result = await service.shutdownInstance('i-session-1');
        expect(result.success).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/worker/services/sandbox/superServeLifecycle.test.ts`
Expected: FAIL — stubs throw `not implemented yet`.

Note: this test needs a preview domain and SuperServe config. The workers-pool test env comes from `wrangler.test.jsonc` — check it defines `CUSTOM_DOMAIN` (or `CUSTOM_PREVIEW_DOMAIN`); if not, add to its `vars` block: `"CUSTOM_DOMAIN": "test.example.com"`, `"JWT_SECRET": "test-jwt-secret"`, and the six `SUPERSERVE_*` vars from Task 1 — but with `"SUPERSERVE_API_KEY": "test-api-key"` (non-empty: `superServeConnection` throws on an empty key, and every provider code path spreads it into SDK call options). The dummy key never reaches the network in unit tests because all SDK calls go through the injected fake `SuperServeApi`.

- [ ] **Step 3: Implement the lifecycle methods**

Replace the corresponding stubs in `superServeSandboxService.ts`:

```ts
// --- add imports ---
import {
    BootstrapResponse, BootstrapStatusResponse, GetInstanceResponse, InstanceCreationRequest,
    ListInstancesResponse, ShutdownResponse, WriteFilesResponse,
} from './sandboxTypes';
import { buildBulkWriteScript, parseBulkWriteOutput } from './bulkFileScript';
import { mintPreviewToken } from './previewToken';
import {
    buildEgressAllowlist, buildSupervisorStartCommand, DEV_SERVER_PORT, INSTALL_TIMEOUT_MS,
    previewTimeoutSeconds,
} from './superServeConfig';
import { getPreviewDomain } from '../../utils/urls';

// --- constants near the top of the class file ---
/** Same readiness signals the Cloudflare provider polls for (sandboxSdkClient.ts:582). */
const READINESS_PATTERNS = [
    /http:\/\/[^\s]+/,
    /ready in \d+/i,
    /Local:\s+http/i,
    /Network:\s+http/i,
    /server running/i,
    /listening on/i,
];

// --- class methods ---

protected async buildSuperServePreviewUrl(port: number, superServeSandboxId: string): Promise<string> {
    const token = await mintPreviewToken(env.JWT_SECRET, port, superServeSandboxId);
    const domain = getPreviewDomain(env);
    return `https://${port}-${superServeSandboxId}-${token}.${domain}`;
}

protected async writeFilesToSandbox(
    sandbox: SuperServeSandboxHandle,
    instanceId: string,
    files: Array<{ filePath: string; fileContents: string }>,
): Promise<WriteFilesResponse> {
    if (files.length === 0) {
        return { success: true, results: [], message: 'No files to write' };
    }
    const absolute = files.map((file) => ({
        filePath: `${this.instanceDir(instanceId)}/${file.filePath}`,
        fileContents: file.fileContents,
    }));
    const script = buildBulkWriteScript(absolute);
    const scriptPath = `/tmp/batch_write_${instanceId}.sh`;
    await sandbox.files.write(scriptPath, script, { timeoutMs: QUICK_TIMEOUT_MS });
    const result = await sandbox.commands.run(`bash ${scriptPath}`, { timeoutMs: 60_000 });
    const parsed = parseBulkWriteOutput(absolute, result.stdout + result.stderr);
    const prefix = `${this.instanceDir(instanceId)}/`;
    return {
        success: true,
        results: parsed.map((r) => ({ ...r, file: r.file.replace(prefix, '') })),
        message: 'Files written successfully',
    };
}

protected async startSupervisedProcess(
    sandbox: SuperServeSandboxHandle,
    instanceId: string,
    initCommand: string,
    port: number,
): Promise<string> {
    const start = buildSupervisorStartCommand(instanceId, initCommand, port);
    const result = await this.runInInstance(sandbox, instanceId, start, QUICK_TIMEOUT_MS);
    if (result.exitCode !== 0) {
        throw new Error(`Failed to start dev server supervisor: ${result.stderr}`);
    }
    return result.stdout.trim();
}

protected async waitForServerReady(
    sandbox: SuperServeSandboxHandle,
    instanceId: string,
    maxWaitTimeMs: number = 10_000,
): Promise<boolean> {
    const pollIntervalMs = 500;
    const maxAttempts = Math.ceil(maxWaitTimeMs / pollIntervalMs);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const logs = await this.runInInstance(
                sandbox, instanceId,
                `timeout 10s monitor-cli logs get -i ${instanceId} --format raw`,
                QUICK_TIMEOUT_MS,
            );
            if (READINESS_PATTERNS.some((pattern) => pattern.test(logs.stdout))) {
                return true;
            }
        } catch (error) {
            this.logger.warn('Readiness poll failed, retrying', { instanceId, attempt, error });
        }
        if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
    }
    this.logger.warn('Dev server readiness timeout', { instanceId, maxWaitTimeMs });
    return false;
}

/** Parses monitor-cli JSON output defensively (harness may prefix noise lines). */
protected parseHarnessJson<T>(stdout: string): T | null {
    const start = stdout.indexOf('{');
    if (start === -1) return null;
    try {
        return JSON.parse(stdout.slice(start)) as T;
    } catch {
        return null;
    }
}

protected async probeInstanceHealth(
    sandbox: SuperServeSandboxHandle,
    instanceId: string,
): Promise<{ isHealthy: boolean; previewURL?: string; tunnelURL?: string; processId?: string; message: string }> {
    let metadata: InstanceMetadata | null = null;
    try {
        metadata = await this.readInstanceMetadata(sandbox, instanceId);
    } catch {
        return { isHealthy: false, message: 'Instance metadata not found' };
    }
    const statusResult = await this.runInInstance(
        sandbox, instanceId,
        `timeout 10s monitor-cli process status --instance-id ${instanceId} --format json`,
        QUICK_TIMEOUT_MS,
    );
    const parsed = this.parseHarnessJson<{ activeProcesses?: number }>(statusResult.stdout);
    const isHealthy = statusResult.exitCode === 0 && (parsed?.activeProcesses ?? 0) > 0;
    return {
        isHealthy,
        previewURL: metadata.previewURL,
        tunnelURL: metadata.tunnelURL,
        processId: metadata.processId,
        message: isHealthy ? 'Instance is running' : 'Dev server process is not running',
    };
}

async createInstance(options: InstanceCreationRequest): Promise<BootstrapResponse> {
    const { files, projectName, webhookUrl, envVars, initCommand } = options;
    const instanceId = this.instanceIdForSession();
    try {
        const existing = await this.findSandbox(instanceId);
        if (existing) {
            const health = await this.probeInstanceHealth(existing, instanceId);
            if (health.isHealthy && health.previewURL) {
                this.logger.info('Reusing healthy existing SuperServe sandbox', { instanceId });
                return {
                    success: true, runId: instanceId, previewURL: health.previewURL,
                    tunnelURL: health.tunnelURL, processId: health.processId, message: health.message,
                };
            }
            this.logger.warn('Existing SuperServe sandbox unhealthy, recreating', { instanceId });
            await existing.kill();
            this.sandboxCache.delete(instanceId);
        }

        const sandbox = await this.api.create({
            ...superServeConnection(env),
            name: instanceId,
            fromTemplate: env.SUPERSERVE_TEMPLATE,
            timeoutSeconds: previewTimeoutSeconds(env),
            envVars,
            network: { allowOut: buildEgressAllowlist(env) },
            metadata: {
                vibesdk_instance: instanceId,
                vibesdk_session: this.sandboxId,
                vibesdk_agent: this.agentId,
                vibesdk_kind: 'preview',
                vibesdk_project: projectName,
            },
        });
        this.sandboxCache.set(instanceId, sandbox);

        const dontTouchFile = files.find((f) => f.filePath === '.donttouch_files.json');
        const dontTouchFiles: string[] = dontTouchFile ? JSON.parse(dontTouchFile.fileContents) : [];
        const redactedFile = files.find((f) => f.filePath === '.redacted_files.json');
        const redactedFiles: string[] = redactedFile ? JSON.parse(redactedFile.fileContents) : [];

        await sandbox.commands.run(`mkdir -p ${this.instanceDir(instanceId)}`, { timeoutMs: QUICK_TIMEOUT_MS });
        const writeResults = await this.writeFilesToSandbox(sandbox, instanceId, files);
        if (!writeResults.success) {
            return { success: false, error: 'Failed to write files to sandbox' };
        }

        await this.applyProjectName(sandbox, instanceId, projectName);

        if (envVars && Object.keys(envVars).length > 0) {
            const devVars = Object.entries(envVars).map(([key, value]) => `${key}=${value}`).join('\n');
            await sandbox.files.write(`${this.instanceDir(instanceId)}/.dev.vars`, devVars, { timeoutMs: QUICK_TIMEOUT_MS });
        }

        const install = await this.runInInstance(sandbox, instanceId, 'bun install', INSTALL_TIMEOUT_MS);
        if (install.exitCode !== 0) {
            return { success: false, error: `Dependency install failed: ${install.stderr.slice(0, 2000)}` };
        }

        const processId = await this.startSupervisedProcess(sandbox, instanceId, initCommand ?? 'bun run dev', DEV_SERVER_PORT);
        await this.waitForServerReady(sandbox, instanceId);

        const previewURL = await this.buildSuperServePreviewUrl(DEV_SERVER_PORT, sandbox.id);
        const metadata: InstanceMetadata = {
            projectName,
            startTime: new Date().toISOString(),
            webhookUrl,
            previewURL,
            processId,
            allocatedPort: DEV_SERVER_PORT,
            donttouch_files: dontTouchFiles,
            redacted_files: redactedFiles,
        };
        await this.writeInstanceMetadata(sandbox, instanceId, metadata);

        return {
            success: true, runId: instanceId,
            message: `Successfully created instance ${instanceId}`,
            previewURL, processId,
        };
    } catch (error) {
        this.logger.error('createInstance failed', error, { instanceId });
        return {
            success: false,
            error: `Failed to create instance: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

/** Same sed-based rename the Cloudflare provider performs (sandboxSdkClient.ts:857-870). */
protected async applyProjectName(
    sandbox: SuperServeSandboxHandle,
    instanceId: string,
    projectName: string,
): Promise<void> {
    const pkg = await this.runInInstance(
        sandbox, instanceId,
        `sed -i '1,10s/"name"[ ]*:[ ]*"[^"]*"/"name": "${projectName}"/' package.json`,
    );
    if (pkg.exitCode !== 0) this.logger.warn('Failed to update package.json name', { stderr: pkg.stderr });
    const wrangler = await this.runInInstance(
        sandbox, instanceId,
        `sed -i '0,/"name":/s/"name"[ ]*:[ ]*"[^"]*"/"name": "${projectName}"/' wrangler.jsonc`,
    );
    if (wrangler.exitCode !== 0) this.logger.warn('Failed to update wrangler.jsonc name', { stderr: wrangler.stderr });
}

async updateProjectName(instanceId: string, projectName: string): Promise<boolean> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        await this.applyProjectName(sandbox, instanceId, projectName);
        const metadata = await this.readInstanceMetadata(sandbox, instanceId);
        await this.writeInstanceMetadata(sandbox, instanceId, { ...metadata, projectName });
        return true;
    } catch (error) {
        this.logger.error('updateProjectName failed', error, { instanceId });
        return false;
    }
}

async getInstanceStatus(instanceId: string): Promise<BootstrapStatusResponse> {
    try {
        const sandbox = await this.findSandbox(instanceId);
        if (!sandbox) {
            return { success: false, pending: false, error: `Instance ${instanceId} not found` };
        }
        const health = await this.probeInstanceHealth(sandbox, instanceId);
        return {
            success: true,
            pending: false,
            isHealthy: health.isHealthy,
            message: health.message,
            previewURL: health.previewURL,
            tunnelURL: health.tunnelURL,
            processId: health.processId,
        };
    } catch (error) {
        this.logger.error('getInstanceStatus failed', error, { instanceId });
        return {
            success: false, pending: false,
            error: `Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async getInstanceDetails(instanceId: string): Promise<GetInstanceResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        const [metadata, info] = await Promise.all([
            this.readInstanceMetadata(sandbox, instanceId),
            sandbox.getInfo(),
        ]);
        const startTime = new Date(metadata.startTime);
        return {
            success: true,
            instance: {
                runId: instanceId,
                startTime: metadata.startTime,
                uptime: Math.max(0, Math.floor((Date.now() - startTime.getTime()) / 1000)),
                previewURL: metadata.previewURL,
                tunnelURL: metadata.tunnelURL,
                directory: this.instanceDir(instanceId),
                serviceDirectory: this.instanceDir(instanceId),
                processId: metadata.processId,
            },
        };
    } catch (error) {
        this.logger.error('getInstanceDetails failed', error, { instanceId });
        return {
            success: false,
            error: `Failed to get instance details: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async listAllInstances(): Promise<ListInstancesResponse> {
    try {
        const matches = await this.api.list({
            ...superServeConnection(env),
            metadata: { vibesdk_session: this.sandboxId, vibesdk_kind: 'preview' },
        });
        const instances = matches.map((info) => ({
            runId: info.metadata?.vibesdk_instance ?? info.name,
            startTime: info.createdAt,
            uptime: Math.max(0, Math.floor((Date.now() - new Date(info.createdAt).getTime()) / 1000)),
            directory: this.instanceDir(info.metadata?.vibesdk_instance ?? info.name),
            serviceDirectory: this.instanceDir(info.metadata?.vibesdk_instance ?? info.name),
        }));
        return { success: true, instances, count: instances.length };
    } catch (error) {
        this.logger.error('listAllInstances failed', error);
        return {
            success: false, instances: [], count: 0,
            error: `Failed to list instances: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async shutdownInstance(instanceId: string): Promise<ShutdownResponse> {
    try {
        const sandbox = await this.findSandbox(instanceId);
        if (!sandbox) {
            return { success: true, message: `Instance ${instanceId} not found, nothing to shut down` };
        }
        // Session/preview sandboxes are paused (cheap resume); the hard
        // timeoutSeconds cap reaps leaked ones. Deploy sandboxes are killed
        // explicitly in the deploy/delete paths.
        await sandbox.pause();
        this.sandboxCache.delete(instanceId);
        return { success: true, message: `Instance ${instanceId} paused` };
    } catch (error) {
        this.logger.error('shutdownInstance failed', error, { instanceId });
        return {
            success: false,
            error: `Failed to shutdown instance: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}
```

`InstanceDetails.fileTree` and `runtimeErrors` are optional per `sandboxTypes.ts:63-75` — omitted here (the debugger fetches errors via `getInstanceErrors`). Check the exact `ListInstancesResponse` instance element type (`rg -n "ListInstancesResponse|InstanceInfo" worker/services/sandbox/sandboxTypes.ts`) and shape the map accordingly — if it requires `previewURL`, add `previewURL: undefined`.

- [ ] **Step 4: Run tests**

Run: `bun run typecheck && bun run test -- test/worker/services/sandbox/superServeLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/services/sandbox/superServeSandboxService.ts test/worker/services/sandbox/superServeLifecycle.test.ts wrangler.test.jsonc
git commit -m "feat: superserve instance lifecycle (create/status/details/list/shutdown/rename)"
```

---

### Task 6: Files, commands, logs, errors, and static analysis

**Files:**
- Modify: `worker/services/sandbox/superServeSandboxService.ts`
- Test: `test/worker/services/sandbox/superServeOperations.test.ts`

**Interfaces:**
- Consumes: Task 5 helpers (`requireSandbox`, `runInInstance`, `writeFilesToSandbox`, `readInstanceMetadata`, `parseHarnessJson`), Task 3 parsers.
- Produces: working `writeFiles`, `getFiles`, `executeCommands`, `getLogs`, `getInstanceErrors`, `clearInstanceErrors`, `runStaticAnalysisCode`. All harness command strings are identical to the Cloudflare provider's (`sandboxSdkClient.ts:1397, 1484, 1530, 1578-1579`), so the same `container/` harness works unchanged (PRD goal 4).

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/superServeOperations.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SuperServeSandboxService } from 'worker/services/sandbox/superServeSandboxService';
import type { SuperServeApi, SuperServeSandboxHandle } from 'worker/services/sandbox/types';

function makeService(runImpl: (command: string) => { stdout: string; stderr: string; exitCode: number }) {
    const writtenFiles = new Map<string, string>();
    writtenFiles.set('/workspace/i-session-1-metadata.json', JSON.stringify({
        projectName: 'my-app', startTime: '2026-07-07T00:00:00Z',
        donttouch_files: ['wrangler.jsonc'], redacted_files: ['.dev.vars'],
    }));
    const runCalls: string[] = [];
    const handle = {
        id: 'ss-1', name: 'i-session-1', status: 'active', metadata: {},
        commands: {
            run: vi.fn(async (command: string) => {
                runCalls.push(command);
                return runImpl(command);
            }),
        },
        files: {
            write: vi.fn(async (path: string, content: string) => { writtenFiles.set(path, content); }),
            readText: vi.fn(async (path: string) => {
                const hit = writtenFiles.get(path);
                if (hit === undefined) throw new Error(`no file ${path}`);
                return hit;
            }),
            read: vi.fn(async () => new Uint8Array()),
            downloadDir: vi.fn(async () => new Uint8Array()),
        },
        getInfo: vi.fn(async () => ({ id: 'ss-1', status: 'active', createdAt: new Date(), metadata: {} })),
        pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), update: vi.fn(),
    } as unknown as SuperServeSandboxHandle;
    const api: SuperServeApi = {
        create: vi.fn(async () => handle),
        connect: vi.fn(async () => handle),
        list: vi.fn(async () => [{ id: 'ss-1' }] as never),
        killById: vi.fn(async () => {}),
        connectTemplate: vi.fn(async () => ({})),
    };
    const service = new SuperServeSandboxService('session-1', 'agent-1', api);
    return { service, runCalls, writtenFiles };
}

describe('writeFiles', () => {
    it('filters donttouch files and reports them as failed', async () => {
        const { service } = makeService((cmd) =>
            cmd.startsWith('bash /tmp/')
                ? { stdout: 'OK:/workspace/i-session-1/src/app.ts\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: '', exitCode: 0 });
        const result = await service.writeFiles('i-session-1', [
            { filePath: 'src/app.ts', fileContents: 'x' },
            { filePath: 'wrangler.jsonc', fileContents: 'y' },
        ]);
        expect(result.success).toBe(true);
        expect(result.results).toContainEqual({ file: 'src/app.ts', success: true, error: undefined });
        expect(result.results).toContainEqual({ file: 'wrangler.jsonc', success: false, error: 'File is forbidden to be modified' });
    });

    it('touches .reload-trigger when TypeScript files were written', async () => {
        const { service, runCalls } = makeService((cmd) =>
            cmd.startsWith('bash /tmp/')
                ? { stdout: 'OK:/workspace/i-session-1/src/app.ts\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: '', exitCode: 0 });
        await service.writeFiles('i-session-1', [{ filePath: 'src/app.ts', fileContents: 'x' }]);
        expect(runCalls.some((c) => c.includes('touch .reload-trigger'))).toBe(true);
    });
});

describe('getFiles', () => {
    it('redacts files listed in metadata redacted_files', async () => {
        const { service, writtenFiles } = makeService(() => ({ stdout: '', stderr: '', exitCode: 0 }));
        writtenFiles.set('/workspace/i-session-1/.dev.vars', 'SECRET=1');
        writtenFiles.set('/workspace/i-session-1/src/app.ts', 'code');
        const result = await service.getFiles('i-session-1', ['.dev.vars', 'src/app.ts']);
        expect(result.success).toBe(true);
        expect(result.files).toContainEqual({ filePath: '.dev.vars', fileContents: '[REDACTED]' });
        expect(result.files).toContainEqual({ filePath: 'src/app.ts', fileContents: 'code' });
    });
});

describe('executeCommands / getLogs / errors', () => {
    it('maps exit codes to per-command results', async () => {
        const { service } = makeService((cmd) =>
            cmd === 'false' ? { stdout: '', stderr: 'boom', exitCode: 1 } : { stdout: 'ok', stderr: '', exitCode: 0 });
        const result = await service.executeCommands('i-session-1', ['true', 'false']);
        expect(result.success).toBe(true);
        expect(result.results[0]).toMatchObject({ command: 'true', success: true, output: 'ok' });
        expect(result.results[1]).toMatchObject({ command: 'false', success: false, exitCode: 1 });
    });

    it('builds the exact monitor-cli logs command with reset and duration', async () => {
        const { service, runCalls } = makeService(() => ({ stdout: 'log-line', stderr: '', exitCode: 0 }));
        const result = await service.getLogs('i-session-1', true, 60);
        expect(result.success).toBe(true);
        expect(result.logs.stdout).toBe('log-line');
        expect(runCalls.some((c) => c.includes('monitor-cli logs get -i i-session-1 --format raw --reset --duration 60'))).toBe(true);
    });

    it('parses monitor-cli errors list JSON into RuntimeErrorResponse', async () => {
        const { service } = makeService((cmd) =>
            cmd.includes('errors list')
                ? { stdout: JSON.stringify({ success: true, errors: [{ timestamp: 't', level: 50, message: 'kaboom', rawOutput: '{}' }] }), stderr: '', exitCode: 0 }
                : { stdout: '', stderr: '', exitCode: 0 });
        const result = await service.getInstanceErrors('i-session-1');
        expect(result.success).toBe(true);
        expect(result.hasErrors).toBe(true);
        expect(result.errors[0].message).toBe('kaboom');
    });
});

describe('runStaticAnalysisCode', () => {
    it('runs lint and tsc and returns parsed issues with summaries', async () => {
        const eslintOut = JSON.stringify([{ filePath: 'src/a.ts', messages: [{ message: 'bad', line: 1, column: 1, severity: 2, ruleId: 'x' }] }]);
        const { service } = makeService((cmd) => {
            if (cmd === 'bun run lint') return { stdout: eslintOut, stderr: '', exitCode: 1 };
            if (cmd.startsWith('bunx tsc')) return { stdout: '', stderr: 'src/b.ts(2,3): error TS2304: Cannot find name.', exitCode: 2 };
            return { stdout: '', stderr: '', exitCode: 0 };
        });
        const result = await service.runStaticAnalysisCode('i-session-1');
        expect(result.success).toBe(true);
        expect(result.lint.issues).toHaveLength(1);
        expect(result.lint.summary?.errorCount).toBe(1);
        expect(result.typecheck.issues[0]).toMatchObject({ ruleId: 'TS2304', line: 2 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/worker/services/sandbox/superServeOperations.test.ts`
Expected: FAIL — stubs throw.

- [ ] **Step 3: Implement the methods**

```ts
// --- additional imports ---
import {
    ClearErrorsResponse, CommandExecutionResult, ExecuteCommandsResponse, GetFilesResponse,
    GetLogsResponse, RuntimeError, RuntimeErrorResponse, StaticAnalysisResponse, WriteFilesRequest,
} from './sandboxTypes';
import { parseESLintJson, parseTscOutput, summarizeIssues } from './staticAnalysisParsers';

// --- class methods ---

async writeFiles(
    instanceId: string,
    files: WriteFilesRequest['files'],
    _commitMessage?: string,
): Promise<WriteFilesResponse> {
    // commitMessage intentionally unused: parity with the Cloudflare provider,
    // whose git history lives in the agent's Durable Object, not the sandbox.
    try {
        const sandbox = await this.requireSandbox(instanceId);
        const metadata = await this.readInstanceMetadata(sandbox, instanceId);
        const donttouchFiles = new Set(metadata.donttouch_files);
        const filteredFiles = files.filter((file) => !donttouchFiles.has(file.filePath));
        const bulkResult = await this.writeFilesToSandbox(sandbox, instanceId, filteredFiles);
        const results = [...bulkResult.results];

        for (const file of files.filter((f) => donttouchFiles.has(f.filePath))) {
            results.push({ file: file.filePath, success: false, error: 'File is forbidden to be modified' });
        }

        const successCount = results.filter((r) => r.success).length;
        // Page-reload nudge, same rationale as sandboxSdkClient.ts:1268-1275.
        if (successCount > 0 && filteredFiles.some((f) => f.filePath.endsWith('.ts') || f.filePath.endsWith('.tsx'))) {
            await this.runInInstance(sandbox, instanceId, 'touch .reload-trigger', QUICK_TIMEOUT_MS);
        }

        return { success: true, results, message: `Successfully wrote ${successCount}/${files.length} files` };
    } catch (error) {
        this.logger.error('writeFiles failed', error, { instanceId });
        return {
            success: false,
            results: files.map((f) => ({ file: f.filePath, success: false, error: 'Instance error' })),
            error: `Failed to write files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async getFiles(instanceId: string, filePaths?: string[]): Promise<GetFilesResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);

        if (!filePaths) {
            // Same expansion the Cloudflare provider does (sandboxSdkClient.ts:1298).
            const importantFiles = await this.runInInstance(
                sandbox, instanceId,
                `jq -r '.[]' .important_files.json | while read -r path; do if [ -d "$path" ]; then find "$path" -type f; elif [ -f "$path" ]; then echo "$path"; fi; done`,
            );
            filePaths = importantFiles.stdout.split('\n').filter((path) => path);
        }

        let redactedPaths = new Set<string>();
        try {
            const metadata = await this.readInstanceMetadata(sandbox, instanceId);
            redactedPaths = new Set(metadata.redacted_files);
        } catch {
            this.logger.warn('Failed to load redacted file list', { instanceId });
        }

        const files: Array<{ filePath: string; fileContents: string }> = [];
        const errors: Array<{ file: string; error: string }> = [];
        const reads = await Promise.allSettled(
            filePaths.map(async (filePath) => ({
                filePath,
                content: await sandbox.files.readText(`${this.instanceDir(instanceId)}/${filePath}`, { timeoutMs: QUICK_TIMEOUT_MS }),
            })),
        );
        reads.forEach((read, index) => {
            if (read.status === 'fulfilled') {
                files.push({
                    filePath: read.value.filePath,
                    fileContents: redactedPaths.has(read.value.filePath) ? '[REDACTED]' : read.value.content,
                });
            } else {
                errors.push({ file: filePaths?.[index] ?? 'unknown', error: 'Failed to read file' });
            }
        });

        return { success: true, files, errors: errors.length > 0 ? errors : undefined };
    } catch (error) {
        this.logger.error('getFiles failed', error, { instanceId });
        return {
            success: false, files: [],
            error: `Failed to get files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async executeCommands(instanceId: string, commands: string[], timeout?: number): Promise<ExecuteCommandsResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        const results: CommandExecutionResult[] = [];
        for (const command of commands) {
            try {
                const result = await this.runInInstance(sandbox, instanceId, command, timeout ?? COMMAND_TIMEOUT_MS);
                results.push({
                    command,
                    success: result.exitCode === 0,
                    output: result.stdout,
                    error: result.stderr || undefined,
                    exitCode: result.exitCode,
                });
            } catch (error) {
                results.push({
                    command, success: false, output: '',
                    error: error instanceof Error ? error.message : 'Execution error',
                });
            }
        }
        const successCount = results.filter((r) => r.success).length;
        return { success: true, results, message: `Executed ${successCount}/${commands.length} commands successfully` };
    } catch (error) {
        this.logger.error('executeCommands failed', error, { instanceId });
        return {
            success: false,
            results: commands.map((command) => ({ command, success: false, output: '', error: 'Instance error' })),
            error: `Failed to execute commands: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async getLogs(instanceId: string, onlyRecent?: boolean, durationSeconds?: number): Promise<GetLogsResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        const durationArg = durationSeconds ? `--duration ${durationSeconds}` : '';
        const cmd = `timeout 10s monitor-cli logs get -i ${instanceId} --format raw ${onlyRecent ? '--reset' : ''} ${durationArg}`.trim();
        const result = await this.runInInstance(sandbox, instanceId, cmd, QUICK_TIMEOUT_MS);
        return { success: true, logs: { stdout: result.stdout, stderr: result.stderr } };
    } catch (error) {
        this.logger.error('getLogs failed', error, { instanceId });
        return {
            success: false, logs: { stdout: '', stderr: '' },
            error: `Failed to get logs: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async getInstanceErrors(instanceId: string, clear?: boolean): Promise<RuntimeErrorResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        const cmd = `timeout 3s monitor-cli errors list -i ${instanceId} --format json ${clear ? '--reset' : ''}`.trim();
        const result = await this.runInInstance(sandbox, instanceId, cmd, QUICK_TIMEOUT_MS);
        const parsed = this.parseHarnessJson<{ errors?: RuntimeError[] }>(result.stdout);
        const errors = parsed?.errors ?? [];
        return { success: true, errors, hasErrors: errors.length > 0 };
    } catch (error) {
        this.logger.error('getInstanceErrors failed', error, { instanceId });
        return {
            success: false, errors: [], hasErrors: false,
            error: `Failed to get errors: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async clearInstanceErrors(instanceId: string): Promise<ClearErrorsResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        await this.runInInstance(sandbox, instanceId, `timeout 3s monitor-cli errors clear -i ${instanceId} --confirm`, QUICK_TIMEOUT_MS);
        return { success: true, message: 'Errors cleared' };
    } catch (error) {
        this.logger.error('clearInstanceErrors failed', error, { instanceId });
        return {
            success: false,
            error: `Failed to clear errors: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}

async runStaticAnalysisCode(instanceId: string): Promise<StaticAnalysisResponse> {
    try {
        const sandbox = await this.requireSandbox(instanceId);
        const [lintResult, tscResult] = await Promise.allSettled([
            this.runInInstance(sandbox, instanceId, 'bun run lint', 120_000),
            this.runInInstance(sandbox, instanceId, 'bunx tsc -b --incremental --noEmit --pretty false', 120_000),
        ]);

        const lintIssues = lintResult.status === 'fulfilled' ? parseESLintJson(lintResult.value.stdout) : [];
        const tscOutput = tscResult.status === 'fulfilled' ? (tscResult.value.stderr || tscResult.value.stdout) : '';
        const typecheckIssues = parseTscOutput(tscOutput);

        return {
            success: true,
            lint: {
                issues: lintIssues,
                summary: summarizeIssues(lintIssues),
                rawOutput: lintResult.status === 'fulfilled'
                    ? `STDOUT: ${lintResult.value.stdout}\nSTDERR: ${lintResult.value.stderr}` : '',
            },
            typecheck: {
                issues: typecheckIssues,
                summary: summarizeIssues(typecheckIssues),
                rawOutput: tscResult.status === 'fulfilled'
                    ? `STDOUT: ${tscResult.value.stdout}\nSTDERR: ${tscResult.value.stderr}` : '',
            },
        };
    } catch (error) {
        this.logger.error('runStaticAnalysisCode failed', error, { instanceId });
        return {
            success: false, lint: { issues: [] }, typecheck: { issues: [] },
            error: `Failed to run analysis: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
    }
}
```

Signature note: the base class declares `runStaticAnalysisCode(instanceId, lintFiles?)`. The Cloudflare impl declares it without `lintFiles` (`sandboxSdkClient.ts:1571`) and TypeScript allows the narrowing; match the base signature here (`lintFiles?: string[]` accepted and unused) or mirror the CF impl — whichever `bun run typecheck` accepts; prefer matching the base signature exactly.

- [ ] **Step 4: Run tests**

Run: `bun run typecheck && bun run test -- test/worker/services/sandbox/superServeOperations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/services/sandbox/superServeSandboxService.ts test/worker/services/sandbox/superServeOperations.test.ts
git commit -m "feat: superserve file/command/log/error/analysis operations via harness CLI"
```

---

### Task 7: Deployment to an always-on sandbox + KV mapping + delete hook

**Files:**
- Modify: `worker/services/sandbox/superServeSandboxService.ts` (`deployToCloudflareWorkers`)
- Create: `worker/services/sandbox/superServeProxy.ts` (deploy-mapping KV helpers only in this task; proxy functions land in Task 9)
- Modify: `worker/api/controllers/apps/controller.ts` (best-effort kill on delete)
- Test: `test/worker/services/sandbox/superServeDeploy.test.ts`

**Interfaces:**
- Consumes: Tasks 4-6 helpers; `env.VibecoderStore` (KV, already bound); `getPreviewDomain` from `worker/utils/urls`.
- Produces:
  - `deployToCloudflareWorkers(instanceId: string, target?: DeploymentTarget): Promise<DeploymentResult>` — name kept for interface parity; on this provider it deploys to SuperServe. Rename to `deployApp` is a flagged fast-follow (PRD §6 naming note).
  - In `superServeProxy.ts`:
    - `interface SuperServeDeployTarget { sandboxId: string; port: number }`
    - `deployMappingKey(deploymentId: string): string` → `` `superserve-deploy-${deploymentId}` ``
    - `putDeployMapping(deploymentId: string, target: SuperServeDeployTarget): Promise<void>`
    - `getDeployMapping(deploymentId: string): Promise<SuperServeDeployTarget | null>`
    - `deleteSuperServeDeployment(deploymentId: string): Promise<void>` — kills the sandbox (metadata lookup) and deletes the KV mapping; safe no-op when nothing exists.

Deployment model (PRD §5.3, decisions 2 and R6): the project tree is tarred out of the session sandbox (excluding `node_modules`/`.git`/`dist`), written into a fresh always-on sandbox, and served by the template's `preview` script (`bun run build && vite preview --host 0.0.0.0 --port ${PORT:-4173}` — verified in `cloudflare/vibesdk-templates` `reference/vite-reference/package.json`) under `monitor-cli` supervision with `PORT=8080`. Redeploys replace the previous deploy sandbox. `deploymentId = projectName` and `deployedUrl = https://{projectName}.{previewDomain}` — identical to the Cloudflare path (`sandboxSdkClient.ts:1907-1908`), so `AppService.updateDeploymentId` and the frontend need no changes.

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/superServeDeploy.test.ts
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { SuperServeSandboxService } from 'worker/services/sandbox/superServeSandboxService';
import { deployMappingKey, getDeployMapping } from 'worker/services/sandbox/superServeProxy';
import type { SuperServeApi, SuperServeSandboxHandle } from 'worker/services/sandbox/types';

function fakeHandle(id: string, files: Map<string, Uint8Array | string>): SuperServeSandboxHandle {
    return {
        id, name: id, status: 'active', metadata: {},
        commands: {
            run: vi.fn(async (command: string) => {
                if (command.includes('monitor-cli logs get')) {
                    return { stdout: 'Local: http://localhost:8080/', stderr: '', exitCode: 0 };
                }
                if (command.includes('echo $!')) return { stdout: '77\n', stderr: '', exitCode: 0 };
                if (command.includes('grep -q \'"preview"\'')) return { stdout: '', stderr: '', exitCode: 0 };
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
        },
        files: {
            write: vi.fn(async (path: string, content: string | Uint8Array) => { files.set(path, content); }),
            readText: vi.fn(async (path: string) => {
                const hit = files.get(path);
                if (typeof hit !== 'string') throw new Error(`no file ${path}`);
                return hit;
            }),
            read: vi.fn(async () => new Uint8Array([1, 2, 3])),
            downloadDir: vi.fn(async () => new Uint8Array()),
        },
        getInfo: vi.fn(async () => ({ id, status: 'active', createdAt: new Date(), metadata: {} })),
        pause: vi.fn(), resume: vi.fn(), kill: vi.fn(async () => {}), update: vi.fn(),
    } as unknown as SuperServeSandboxHandle;
}

describe('deployToCloudflareWorkers on superserve', () => {
    it('creates an always-on deploy sandbox, transfers the tree, starts preview, and persists the KV mapping', async () => {
        const sourceFiles = new Map<string, Uint8Array | string>();
        sourceFiles.set('/workspace/i-session-1-metadata.json', JSON.stringify({
            projectName: 'my-app', startTime: '2026-07-07T00:00:00Z', donttouch_files: [], redacted_files: [],
        }));
        const source = fakeHandle('ss-source', sourceFiles);
        const deployFiles = new Map<string, Uint8Array | string>();
        const deployed = fakeHandle('ss-deployed', deployFiles);

        const created: unknown[] = [];
        const api: SuperServeApi = {
            create: vi.fn(async (options) => { created.push(options); return deployed; }),
            connect: vi.fn(async (id: string) => (id === 'ss-source' ? source : deployed)),
            list: vi.fn(async (options: { metadata?: Record<string, string> }) => {
                if (options.metadata?.vibesdk_instance === 'i-session-1') return [{ id: 'ss-source' }] as never;
                return [] as never;
            }),
            killById: vi.fn(async () => {}),
            connectTemplate: vi.fn(async () => ({})),
        };

        const service = new SuperServeSandboxService('session-1', 'agent-1', api);
        const result = await service.deployToCloudflareWorkers('i-session-1');

        expect(result.success).toBe(true);
        expect(result.deploymentId).toBe('my-app');
        expect(result.deployedUrl).toContain('my-app.');

        const createOptions = created[0] as { timeoutSeconds?: number; metadata: Record<string, string> };
        expect(createOptions.timeoutSeconds).toBeUndefined();
        expect(createOptions.metadata.vibesdk_kind).toBe('deploy');
        expect(createOptions.metadata.vibesdk_deployment).toBe('my-app');

        const mapping = await getDeployMapping('my-app');
        expect(mapping).toEqual({ sandboxId: 'ss-deployed', port: 8080 });
        await env.VibecoderStore.delete(deployMappingKey('my-app'));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/worker/services/sandbox/superServeDeploy.test.ts`
Expected: FAIL — `superServeProxy` module missing / deploy stub throws.

(`wrangler.test.jsonc` must bind `VibecoderStore` KV for the workers-pool test env — check with `rg -n "VibecoderStore" wrangler.test.jsonc`; if absent, add a `kv_namespaces` entry mirroring `wrangler.jsonc`.)

- [ ] **Step 3: Create the KV mapping half of `superServeProxy.ts`**

```ts
// worker/services/sandbox/superServeProxy.ts
import { env } from 'cloudflare:workers';
import { Sandbox as SuperServeSandbox } from '@superserve/sdk';
import { createObjectLogger } from '../../logger';
import { superServeConnection } from './superServeConfig';

const logger = createObjectLogger({ component: 'superserve', operation: 'proxy' });

export interface SuperServeDeployTarget {
    sandboxId: string;
    port: number;
}

export function deployMappingKey(deploymentId: string): string {
    return `superserve-deploy-${deploymentId}`;
}

export async function putDeployMapping(deploymentId: string, target: SuperServeDeployTarget): Promise<void> {
    await env.VibecoderStore.put(deployMappingKey(deploymentId), JSON.stringify(target));
}

export async function getDeployMapping(deploymentId: string): Promise<SuperServeDeployTarget | null> {
    const raw = await env.VibecoderStore.get(deployMappingKey(deploymentId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as SuperServeDeployTarget;
        return typeof parsed.sandboxId === 'string' && typeof parsed.port === 'number' ? parsed : null;
    } catch {
        return null;
    }
}

/** Best-effort teardown when an app is deleted or redeployed. */
export async function deleteSuperServeDeployment(deploymentId: string): Promise<void> {
    try {
        const matches = await SuperServeSandbox.list({
            ...superServeConnection(env),
            metadata: { vibesdk_kind: 'deploy', vibesdk_deployment: deploymentId },
        });
        for (const info of matches) {
            await SuperServeSandbox.killById(info.id, superServeConnection(env));
        }
    } catch (error) {
        logger.warn('Failed to kill deploy sandbox (continuing)', { deploymentId, error });
    }
    await env.VibecoderStore.delete(deployMappingKey(deploymentId));
}
```

- [ ] **Step 4: Implement `deployToCloudflareWorkers` in the provider**

```ts
// --- additional imports in superServeSandboxService.ts ---
import { DeploymentResult } from './sandboxTypes';
import { DeploymentTarget } from 'worker/agents/core/types';
import { deployMappingKey, putDeployMapping } from './superServeProxy';
import { getPreviewDomain } from '../../utils/urls';

// --- class method ---

/**
 * On the SuperServe provider, "deploy" provisions one always-on sandbox per
 * app running the template's preview server (PRD decisions 2 and R6). The
 * method name is kept for BaseSandboxService compatibility; rename to
 * deployApp() is a flagged fast-follow across the interface.
 */
async deployToCloudflareWorkers(instanceId: string, _target: DeploymentTarget = 'platform'): Promise<DeploymentResult> {
    try {
        const source = await this.requireSandbox(instanceId);
        const metadata = await this.readInstanceMetadata(source, instanceId);
        const deploymentId = metadata.projectName;

        // 1. Archive the project tree (sources only) out of the session sandbox.
        const archivePath = `/tmp/deploy-${instanceId}.tar.gz`;
        const tar = await source.commands.run(
            `tar czf ${archivePath} --exclude node_modules --exclude .git --exclude dist -C ${this.instanceDir(instanceId)} .`,
            { timeoutMs: 60_000 },
        );
        if (tar.exitCode !== 0) {
            return { success: false, message: 'Deployment failed', error: `tar failed: ${tar.stderr.slice(0, 2000)}` };
        }
        const archive = await source.files.read(archivePath, { timeoutMs: 60_000 });

        // 2. Replace any previous deploy sandbox for this app. Uses the
        //    injected api (not the module-level helper) so tests stay offline.
        const previous = await this.api.list({
            ...superServeConnection(env),
            metadata: { vibesdk_kind: 'deploy', vibesdk_deployment: deploymentId },
        });
        for (const info of previous) {
            await this.api.killById(info.id, superServeConnection(env));
        }
        await env.VibecoderStore.delete(deployMappingKey(deploymentId));

        // 3. Always-on sandbox: no timeoutSeconds, never paused.
        const deploySandbox = await this.api.create({
            ...superServeConnection(env),
            name: `d-${deploymentId}`.slice(0, 63),
            fromTemplate: env.SUPERSERVE_TEMPLATE,
            envVars: { NODE_ENV: 'production' },
            network: { allowOut: buildEgressAllowlist(env) },
            metadata: {
                vibesdk_kind: 'deploy',
                vibesdk_deployment: deploymentId,
                vibesdk_instance: instanceId,
                vibesdk_agent: this.agentId,
            },
        });

        // 4. Transfer and unpack.
        await deploySandbox.files.write('/tmp/app.tar.gz', archive, { timeoutMs: 60_000 });
        const unpack = await deploySandbox.commands.run(
            `mkdir -p /workspace/${deploymentId} && tar xzf /tmp/app.tar.gz -C /workspace/${deploymentId}`,
            { timeoutMs: 60_000 },
        );
        if (unpack.exitCode !== 0) {
            return { success: false, message: 'Deployment failed', error: `unpack failed: ${unpack.stderr.slice(0, 2000)}` };
        }

        const runInDeploy = (command: string, timeoutMs: number) =>
            deploySandbox.commands.run(command, { cwd: `/workspace/${deploymentId}`, timeoutMs });

        // 5. Install and serve. Templates define `preview` = build + serve
        //    (vite preview honoring PORT); fall back to the dev server if absent.
        const install = await runInDeploy('bun install', INSTALL_TIMEOUT_MS);
        if (install.exitCode !== 0) {
            return { success: false, message: 'Deployment failed', error: `bun install failed: ${install.stderr.slice(0, 2000)}` };
        }
        const hasPreview = await runInDeploy(`grep -q '"preview"' package.json`, QUICK_TIMEOUT_MS);
        const serveCommand = hasPreview.exitCode === 0 ? 'bun run preview' : 'bun run dev';
        const startCmd = buildSupervisorStartCommand(deploymentId, serveCommand, DEV_SERVER_PORT);
        const started = await runInDeploy(startCmd, QUICK_TIMEOUT_MS);
        if (started.exitCode !== 0) {
            return { success: false, message: 'Deployment failed', error: `server start failed: ${started.stderr.slice(0, 2000)}` };
        }

        // 6. Wait for the preview server (includes the production build) to come up.
        await this.waitForDeployReady(deploySandbox, deploymentId, 120_000);

        // 7. Persist mapping and answer with the vibesdk-served URL.
        await putDeployMapping(deploymentId, { sandboxId: deploySandbox.id, port: DEV_SERVER_PORT });
        const deployedUrl = `https://${deploymentId}.${getPreviewDomain(env)}`;
        this.logger.info('SuperServe deployment complete', { instanceId, deploymentId, sandboxId: deploySandbox.id });
        return {
            success: true,
            message: `Successfully deployed ${instanceId} to an always-on SuperServe sandbox`,
            deployedUrl,
            deploymentId,
            output: 'Deployed',
        };
    } catch (error) {
        this.logger.error('deployToCloudflareWorkers failed', error, { instanceId });
        return {
            success: false,
            message: `Deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

protected async waitForDeployReady(
    sandbox: SuperServeSandboxHandle,
    deploymentId: string,
    maxWaitTimeMs: number,
): Promise<boolean> {
    const pollIntervalMs = 2_000;
    const maxAttempts = Math.ceil(maxWaitTimeMs / pollIntervalMs);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const logs = await sandbox.commands.run(
            `timeout 10s monitor-cli logs get -i ${deploymentId} --format raw`,
            { cwd: `/workspace/${deploymentId}`, timeoutMs: QUICK_TIMEOUT_MS },
        );
        if (READINESS_PATTERNS.some((pattern) => pattern.test(logs.stdout))) {
            return true;
        }
        if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
    }
    this.logger.warn('Deploy readiness timeout (build may still be running)', { deploymentId, maxWaitTimeMs });
    return false;
}
```

- [ ] **Step 5: Hook app deletion**

In `worker/api/controllers/apps/controller.ts`, locate the delete controller (the method calling `appService.deleteApp(appId, user.id)`). After a successful delete, add a best-effort teardown (the app row carries `deploymentId`; fetch it before deleting or from the service result — read the surrounding code and use whichever the controller already has in scope):

```ts
import { deleteSuperServeDeployment } from '../../../services/sandbox/superServeProxy';
// after successful deletion, where `app.deploymentId` (or equivalent) is available:
if (result.success && app?.deploymentId) {
    ctx.waitUntil(deleteSuperServeDeployment(app.deploymentId));
}
```

If the controller does not have the app record in scope, fetch it before deletion via the same `AppService` the controller already uses (`getApp`/`findById` — match the existing method name). Adjust `ctx` to the controller's actual `ExecutionContext` parameter name; if none is available, `await` the call in a try/catch that only logs.

- [ ] **Step 6: Run tests**

Run: `bun run typecheck && bun run test -- test/worker/services/sandbox/superServeDeploy.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/services/sandbox/superServeSandboxService.ts worker/services/sandbox/superServeProxy.ts worker/api/controllers/apps/controller.ts test/worker/services/sandbox/superServeDeploy.test.ts wrangler.test.jsonc
git commit -m "feat: superserve always-on app deployment with KV mapping and delete teardown"
```

---

### Task 8: Factory branch

**Files:**
- Modify: `worker/services/sandbox/factory.ts`

**Interfaces:**
- Consumes: `SuperServeSandboxService` (Tasks 4-7).
- Produces: `getSandboxService(sessionId, agentId)` returns the SuperServe provider when `env.SANDBOX_SERVICE_TYPE === 'superserve'`.

- [ ] **Step 1: Modify `factory.ts`** (full new contents)

```ts
import { SandboxSdkClient } from "./sandboxSdkClient";
import { RemoteSandboxServiceClient } from "./remoteSandboxService";
import { SuperServeSandboxService } from "./superServeSandboxService";
import { BaseSandboxService } from "./BaseSandboxService";
import { env } from 'cloudflare:workers'

export function getSandboxService(sessionId: string, agentId: string): BaseSandboxService {
    if (env.SANDBOX_SERVICE_TYPE == 'runner') {
        console.log("[getSandboxService] Using runner service for sandboxing");
        return new RemoteSandboxServiceClient(sessionId);
    }
    if (env.SANDBOX_SERVICE_TYPE == 'superserve') {
        console.log("[getSandboxService] Using superserve service for sandboxing");
        return new SuperServeSandboxService(sessionId, agentId);
    }
    console.log("[getSandboxService] Using sandboxsdk service for sandboxing");
    return new SandboxSdkClient(sessionId, agentId);
}
```

- [ ] **Step 2: Typecheck and full test run**

Run: `bun run typecheck && bun run test`
Expected: green. The default (non-`superserve`) path is untouched — rollback criterion §11.6.

- [ ] **Step 3: Commit**

```bash
git add worker/services/sandbox/factory.ts
git commit -m "feat: select SuperServeSandboxService via SANDBOX_SERVICE_TYPE=superserve"
```

---

### Task 9: Preview proxy branch (`request-handler.ts` + proxy functions)

**Files:**
- Create: `worker/services/sandbox/routeParser.ts` (move `RouteInfo` + `extractSandboxRoute` verbatim from `request-handler.ts:18-123`; keep `request-handler.ts` re-importing them so its behavior is unchanged)
- Modify: `worker/services/sandbox/superServeProxy.ts` (add target builder + proxy functions)
- Modify: `worker/services/sandbox/request-handler.ts` (import parser from `routeParser.ts`, delegate when enabled)
- Test: `test/worker/services/sandbox/superServeProxy.test.ts`

**Interfaces:**
- Consumes: `extractSandboxRoute(url: URL): RouteInfo | null` from the new `routeParser.ts` (single source for the subdomain contract — both providers parse the same shape; `request-handler.ts` keeps exporting `RouteInfo` for existing importers if any), Task 2 `verifyPreviewToken`, Task 4 config.
- Produces:
  - `buildSuperServeTargetUrl(sandboxHost: string, sandboxId: string, port: number, path: string, search: string): string`
  - `proxyToSuperServeTarget(request: Request, target: SuperServeDeployTarget, deps?: { fetchImpl?: typeof fetch; resumeSandbox?: (sandboxId: string) => Promise<void> }): Promise<Response>`
  - `proxySuperServePreview(request: Request): Promise<Response | null>` — full preview handler used by `request-handler.ts`.

Behavior:
- Same subdomain contract; the `{sandboxId}` segment is the SuperServe sandbox id (UUID — dashes in the middle are accepted by the existing regex, and `5+1+36+1+16 = 59` chars fits the 63-char DNS label limit).
- Token is verified in the Worker (`verifyPreviewToken` with `env.JWT_SECRET`); invalid → 403 (do NOT fall through to the dispatcher).
- WebSocket upgrades: forward via `fetch` and return the upstream response untouched (workerd propagates the 101 + socket; Vite HMR works — the SuperServe edge uses Go `httputil.ReverseProxy`, which proxies upgrades).
- Non-WS responses: strip `Service-Worker-Allowed`, `Service-Worker-Navigation-Preload`, `Clear-Site-Data` (same set as `space/src/space/preview-headers.ts:10-14`; duplicated here because `@space-do/space` only exports its built dist and the worker does not depend on it).
- 503 with a `sandbox is …` body (the SuperServe data plane's paused/resuming signal, plain text with `Retry-After: 5`) → resume via control plane and retry once, GET/HEAD only. Other methods return the 503 (client retries).

- [ ] **Step 1: Write the failing test**

```ts
// test/worker/services/sandbox/superServeProxy.test.ts
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
    buildSuperServeTargetUrl,
    proxySuperServePreview,
    proxyToSuperServeTarget,
} from 'worker/services/sandbox/superServeProxy';
import { mintPreviewToken } from 'worker/services/sandbox/previewToken';

const SSID = '2b7e1c1e-9d1c-4a7b-b1e0-1f2e3d4c5b6a';

describe('buildSuperServeTargetUrl', () => {
    it('builds the data-plane preview URL', () => {
        expect(buildSuperServeTargetUrl('sandbox.superserve.ai', SSID, 8080, '/assets/app.js', '?v=1'))
            .toBe(`https://8080-${SSID}.sandbox.superserve.ai/assets/app.js?v=1`);
    });
});

describe('proxyToSuperServeTarget', () => {
    it('forwards and strips service-worker headers', async () => {
        const upstream = new Response('ok', {
            status: 200,
            headers: { 'Service-Worker-Allowed': '/', 'Content-Type': 'text/plain' },
        });
        const fetchImpl = vi.fn(async () => upstream);
        const response = await proxyToSuperServeTarget(
            new Request('https://ignored.example.com/x'),
            { sandboxId: SSID, port: 8080 },
            { fetchImpl },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('Service-Worker-Allowed')).toBeNull();
        expect(response.headers.get('Content-Type')).toBe('text/plain');
    });

    it('resumes and retries once on a paused-sandbox 503 for GET', async () => {
        const resumeSandbox = vi.fn(async () => {});
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('sandbox is paused\n', { status: 503, headers: { 'Retry-After': '5' } }))
            .mockResolvedValueOnce(new Response('recovered', { status: 200 }));
        const response = await proxyToSuperServeTarget(
            new Request('https://ignored.example.com/'),
            { sandboxId: SSID, port: 8080 },
            { fetchImpl, resumeSandbox },
        );
        expect(resumeSandbox).toHaveBeenCalledWith(SSID);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('recovered');
    });

    it('does not retry non-GET methods on 503', async () => {
        const resumeSandbox = vi.fn(async () => {});
        const fetchImpl = vi.fn(async () => new Response('sandbox is paused\n', { status: 503 }));
        const response = await proxyToSuperServeTarget(
            new Request('https://ignored.example.com/', { method: 'POST', body: 'data' }),
            { sandboxId: SSID, port: 8080 },
            { fetchImpl, resumeSandbox },
        );
        expect(response.status).toBe(503);
        expect(resumeSandbox).not.toHaveBeenCalled();
    });
});

describe('proxySuperServePreview', () => {
    it('returns null for non-preview hostnames', async () => {
        const response = await proxySuperServePreview(new Request('https://example.com/'));
        expect(response).toBeNull();
    });

    it('rejects an invalid token with 403 without contacting the target', async () => {
        const fetchImpl = vi.fn();
        const domain = env.CUSTOM_DOMAIN;
        const request = new Request(`https://8080-${SSID}-0000000000000000.${domain}/`);
        const response = await proxySuperServePreview(request, { fetchImpl });
        expect(response?.status).toBe(403);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('proxies a request carrying a valid token', async () => {
        const token = await mintPreviewToken(env.JWT_SECRET, 8080, SSID);
        const domain = env.CUSTOM_DOMAIN;
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input instanceof Request ? input.url : input))
                .toBe(`https://8080-${SSID}.${env.SUPERSERVE_SANDBOX_HOST}/index.html`);
            return new Response('app');
        });
        const request = new Request(`https://8080-${SSID}-${token}.${domain}/index.html`);
        const response = await proxySuperServePreview(request, { fetchImpl });
        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe('app');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/worker/services/sandbox/superServeProxy.test.ts`
Expected: FAIL — functions not exported yet.

- [ ] **Step 3: Add the proxy functions to `superServeProxy.ts`**

```ts
// --- additional imports ---
import { verifyPreviewToken } from './previewToken';
import { extractSandboxRoute } from './routeParser';
import { superServeSandboxHost } from './superServeConfig';

/** Response headers a generated app must not control on the shared preview origin. */
const STRIPPED_PREVIEW_HEADERS = [
    'Service-Worker-Allowed',
    'Service-Worker-Navigation-Preload',
    'Clear-Site-Data',
];

export function buildSuperServeTargetUrl(
    sandboxHost: string,
    sandboxId: string,
    port: number,
    path: string,
    search: string,
): string {
    return `https://${port}-${sandboxId}.${sandboxHost}${path}${search}`;
}

interface ProxyDeps {
    fetchImpl?: typeof fetch;
    resumeSandbox?: (sandboxId: string) => Promise<void>;
}

async function resumeViaControlPlane(sandboxId: string): Promise<void> {
    const sandbox = await SuperServeSandbox.connect(sandboxId, superServeConnection(env));
    if (sandbox.status !== 'active') {
        await sandbox.resume();
    }
}

function isPausedSandboxResponse(response: Response): boolean {
    return response.status === 503;
}

export async function proxyToSuperServeTarget(
    request: Request,
    target: SuperServeDeployTarget,
    deps: ProxyDeps = {},
): Promise<Response> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const resumeSandbox = deps.resumeSandbox ?? resumeViaControlPlane;
    const url = new URL(request.url);
    const targetUrl = buildSuperServeTargetUrl(
        superServeSandboxHost(env), target.sandboxId, target.port, url.pathname, url.search,
    );

    // WebSocket upgrades pass through untouched; workerd propagates the
    // 101 + socket from the upstream fetch (Vite HMR relies on this).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return fetchImpl(new Request(targetUrl, request));
    }

    const canRetry = request.method === 'GET' || request.method === 'HEAD';
    let response = await fetchImpl(new Request(targetUrl, request));

    // Data-plane 503 = paused/resuming sandbox (plain-text "sandbox is ..."
    // body, Retry-After: 5). Resume via control plane and retry once for
    // idempotent methods; the raw preview fetch has no SDK auto-resume.
    if (isPausedSandboxResponse(response) && canRetry) {
        try {
            await resumeSandbox(target.sandboxId);
            response = await fetchImpl(new Request(targetUrl, request));
        } catch (error) {
            logger.warn('SuperServe sandbox resume failed', { sandboxId: target.sandboxId, error });
        }
    }

    if (response.status === 101 || response.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return response;
    }
    const headers = new Headers(response.headers);
    for (const name of STRIPPED_PREVIEW_HEADERS) {
        headers.delete(name);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * SuperServe preview handler for {port}-{superserveSandboxId}-{token}.{domain}
 * hostnames. The token is HMAC-verified here — on this provider the Worker,
 * not the sandbox, is the auth boundary.
 */
export async function proxySuperServePreview(request: Request, deps: ProxyDeps = {}): Promise<Response | null> {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);
    if (!routeInfo) {
        return null;
    }
    const { port, sandboxId, token } = routeInfo;

    const tokenValid = await verifyPreviewToken(env.JWT_SECRET, port, sandboxId, token);
    if (!tokenValid) {
        logger.warn('Rejected preview request with invalid token', { hostname: url.hostname });
        return new Response('Invalid preview token', { status: 403 });
    }

    try {
        return await proxyToSuperServeTarget(request, { sandboxId, port }, deps);
    } catch (error) {
        logger.error('SuperServe preview proxy error', error instanceof Error ? error : new Error(String(error)));
        return new Response('Preview proxy error', { status: 500 });
    }
}
```

Create `worker/services/sandbox/routeParser.ts` first: move `RouteInfo` (request-handler.ts:18-23) and `extractSandboxRoute` (request-handler.ts:95-123) there verbatim as exports, then have `request-handler.ts` import both from `./routeParser` (and re-export `RouteInfo` if anything else imports it — check with `rg -rn "RouteInfo" worker src`). This keeps one source for the subdomain contract without creating an import cycle (`request-handler.ts` → `superServeProxy.ts` → `routeParser.ts`).

- [ ] **Step 4: Wire into `request-handler.ts`**

At the top of `proxyToSandbox` (after the `const url = new URL(request.url);` / route extraction can stay as is), add the provider gate before any Cloudflare-specific work:

```ts
import { env as workerEnv } from 'cloudflare:workers';
import { isSuperServeEnabled } from './superServeConfig';
import { proxySuperServePreview } from './superServeProxy';

export async function proxyToSandbox<E extends SandboxEnv>(
  request: Request,
  env: E
): Promise<Response | null> {
  try {
    if (isSuperServeEnabled(workerEnv)) {
      return await proxySuperServePreview(request);
    }
    // ... existing Cloudflare path unchanged ...
```

Note on `env`: `request-handler.ts` receives a generic `E extends SandboxEnv` param, but `superServeConfig.isSuperServeEnabled` reads the module-scoped `env` from `cloudflare:workers` (same pattern the rest of the sandbox layer uses — `BaseSandboxService.ts:36`). Import it as `import { env as workerEnv } from 'cloudflare:workers';` and call `isSuperServeEnabled(workerEnv)`.

- [ ] **Step 5: Run tests**

Run: `bun run typecheck && bun run test -- test/worker/services/sandbox/superServeProxy.test.ts && bun run test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add worker/services/sandbox/routeParser.ts worker/services/sandbox/superServeProxy.ts worker/services/sandbox/request-handler.ts test/worker/services/sandbox/superServeProxy.test.ts
git commit -m "feat: proxy superserve previews through the worker with token auth and 503 resume"
```

---

### Task 10: Deployed-app routing in `worker/index.ts`

**Files:**
- Modify: `worker/index.ts` (the deployed-app dispatch section, lines 148-181)

**Interfaces:**
- Consumes: `getDeployMapping`, `proxyToSuperServeTarget` (Tasks 7 and 9).
- Produces: requests to `{appName}.{previewDomain}` are served from the app's always-on SuperServe sandbox when a KV mapping exists; otherwise the existing dispatcher path runs unchanged.

Design note: the KV lookup runs regardless of `SANDBOX_SERVICE_TYPE` so apps deployed on SuperServe keep working even if the flag is rolled back (flag gates *new* previews/deploys, not serving). A KV miss costs ~1 ms and falls through to the dispatcher, so criterion §11.6 holds.

- [ ] **Step 1: Modify the dispatch section**

Immediately after the sandbox-miss log line (`worker/index.ts:149`) and before the `isDispatcherAvailable` check, insert:

```ts
import { getDeployMapping, proxyToSuperServeTarget } from './services/sandbox/superServeProxy';

// 2a. Apps deployed to SuperServe are resolved via the KV mapping written at
// deploy time; miss falls through to the Workers-for-Platforms dispatcher.
const superServeTarget = await getDeployMapping(subdomain);
if (superServeTarget) {
    logger.info(`Serving SuperServe-deployed app for: ${hostname}`);
    const superServeResponse = await proxyToSuperServeTarget(request, superServeTarget);
    let headers = new Headers(superServeResponse.headers);
    headers.set('X-Preview-Type', 'superserve');
    headers = setOriginControl(env, request, headers);
    headers.append('Vary', 'Origin');
    headers.set('Access-Control-Expose-Headers', 'X-Preview-Type');
    return new Response(superServeResponse.body, {
        status: superServeResponse.status,
        statusText: superServeResponse.statusText,
        headers,
    });
}
```

If the response is a WebSocket upgrade (`status === 101`), return `superServeResponse` as-is before header manipulation — mirror the existing sandbox-response WS guard at `worker/index.ts:124-127`:

```ts
    if (superServeResponse.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return superServeResponse;
    }
```

(Place this guard immediately after the `proxyToSuperServeTarget` call, before constructing `headers`.)

- [ ] **Step 2: Typecheck + full tests**

Run: `bun run typecheck && bun run test`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "feat: route superserve-deployed apps via KV mapping before dispatcher"
```

---

### Task 11: SuperServe template build script + runbook

**Files:**
- Create: `scripts/superserve/build-template.ts`
- Create: `docs/superserve-sandbox.md`

**Interfaces:**
- Consumes: `@superserve/sdk` `Template.create` / `waitUntilReady` (SDK builds templates fully server-side from a base image + build steps; there is no Dockerfile upload).
- Produces: a reusable `vibesdk-sandbox` template with Bun, Node, git, and the `container/` harness preinstalled (`monitor-cli` on PATH) — the SuperServe analog of `SandboxDockerfile` (PRD §5.4, rollout step 1).

Before writing the steps, read `SandboxDockerfile` (repo root) and mirror what it does for the harness: copy `container/`, `bun install && bun run build`, symlink `cli-tools.ts` to `/usr/local/bin/monitor-cli`, git identity `vibesdk-bot@cloudflare.com`, env `VITE_LOGGER_TYPE=json`. Cloudflared/tunnel steps are Cloudflare-only — skip them. Since `Template.create` steps cannot COPY local files, the harness is cloned from the vibesdk repo at a pinned ref (override `VIBESDK_REPO`/`VIBESDK_REF` for forks/branches).

- [ ] **Step 1: Write the script**

```ts
// scripts/superserve/build-template.ts
// Builds (or rebuilds) the SuperServe sandbox template used by
// SuperServeSandboxService. Run manually with bun:
//   SUPERSERVE_API_KEY=... bun run scripts/superserve/build-template.ts
// Optional: SUPERSERVE_TEMPLATE, SUPERSERVE_BASE_URL, VIBESDK_REPO, VIBESDK_REF
import { Template } from '@superserve/sdk';

const name = process.env.SUPERSERVE_TEMPLATE ?? 'vibesdk-sandbox';
const repo = process.env.VIBESDK_REPO ?? 'https://github.com/cloudflare/vibesdk';
const ref = process.env.VIBESDK_REF ?? 'main';
const baseUrl = process.env.SUPERSERVE_BASE_URL || undefined;
const apiKey = process.env.SUPERSERVE_API_KEY;
if (!apiKey) {
    console.error('SUPERSERVE_API_KEY is required');
    process.exit(1);
}

async function main(): Promise<void> {
    try {
        const existing = await Template.connect(name, { apiKey, baseUrl });
        console.log(`Template ${name} exists; deleting before rebuild`);
        await existing.delete();
    } catch {
        // Not found: first build.
    }

    console.log(`Creating template ${name} from ${repo}@${ref}`);
    const template = await Template.create({
        apiKey,
        baseUrl,
        name,
        // Mirrors wrangler.jsonc containers instance_type (4 vcpu / 8 GiB / 10 GiB disk).
        vcpu: 4,
        memoryMib: 8192,
        diskMib: 10240,
        from: 'ubuntu:24.04',
        steps: [
            { run: 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates git unzip procps net-tools jq xz-utils' },
            // Node 22 (some template tooling expects node on PATH).
            { run: 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs' },
            // Bun (primary runtime for the harness and generated apps).
            { run: 'curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx' },
            // The in-sandbox harness (same code path as SandboxDockerfile).
            { run: `git clone --depth 1 --branch ${ref} ${repo} /opt/vibesdk && cd /opt/vibesdk/container && bun install && bun run build && ln -sf /opt/vibesdk/container/cli-tools.ts /usr/local/bin/monitor-cli && chmod +x /opt/vibesdk/container/cli-tools.ts` },
            { run: 'git config --global user.email vibesdk-bot@cloudflare.com && git config --global user.name vibesdk-bot' },
            { run: 'mkdir -p /workspace/data' },
            { env: { key: 'VITE_LOGGER_TYPE', value: 'json' } },
            { env: { key: 'CLI_DATA_DIR', value: '/workspace/data' } },
            { env: { key: 'CONTAINER_ENV', value: 'superserve' } },
        ],
        readyCmd: 'test -x /usr/local/bin/monitor-cli',
    });

    const info = await template.waitUntilReady({
        onLog: (event) => console.log(`[${event.stream}] ${event.text}`),
    });
    console.log(`Template ready: ${info.name} (${info.status})`);
}

main().catch((error) => {
    console.error('Template build failed:', error);
    process.exit(1);
});
```

Cross-check against `SandboxDockerfile` while implementing: if the harness build emits a different binary name or needs extra env (`CLI_ERROR_DB_PATH`, `CLI_LOG_DB_PATH`), mirror it. If `container/cli-tools.ts` relies on `CONTAINER_ENV=docker` for behavior switches (`rg -n "CONTAINER_ENV" container/`), keep the value `docker` instead of `superserve`.

- [ ] **Step 2: Sanity-check the script parses**

Run: `bunx tsc --noEmit --target es2022 --module es2022 --moduleResolution bundler --skipLibCheck scripts/superserve/build-template.ts`
Expected: no errors. (Do NOT run the script itself here — it creates real cloud resources; it is exercised in the staging rollout, step 1 of PRD §13.)

- [ ] **Step 3: Write the runbook `docs/superserve-sandbox.md`**

Contents (write in full):

```markdown
# SuperServe Sandbox Provider

Runs generated-app preview and deployment on SuperServe sandboxes instead of
Cloudflare Containers / Workers for Platforms.

## Enable

1. Build the sandbox template (one-time, and after harness changes):
   `SUPERSERVE_API_KEY=... bun run scripts/superserve/build-template.ts`
2. Set Worker config: `SANDBOX_SERVICE_TYPE=superserve`, `SUPERSERVE_API_KEY`
   (secret), `SUPERSERVE_TEMPLATE` (default `vibesdk-sandbox`),
   `SUPERSERVE_SANDBOX_HOST` (default `sandbox.superserve.ai`),
   optional `SUPERSERVE_BASE_URL`, `SUPERSERVE_EGRESS_ALLOW` (csv),
   `SUPERSERVE_PREVIEW_TIMEOUT_SECONDS` (default 86400).
3. Rollback: set `SANDBOX_SERVICE_TYPE` back to its previous value. No code
   changes. Apps already deployed to SuperServe keep serving (KV mapping is
   checked before the dispatcher); Cloudflare-dispatched apps are unaffected.

## Architecture

- One SuperServe sandbox per active chat session (metadata
  `vibesdk_instance=i-{sessionId}`), paused on shutdown, hard-capped by
  `timeoutSeconds` as a leak backstop.
- One always-on sandbox per deployed app (metadata `vibesdk_kind=deploy`,
  `vibesdk_deployment={projectName}`), no timeout, killed on app delete and
  replaced on redeploy. Serving mapping lives in KV:
  `superserve-deploy-{projectName}` -> `{sandboxId, port}`.
- Preview URLs keep the `{port}-{sandboxId}-{token}.{previewDomain}` contract;
  `{sandboxId}` is the SuperServe sandbox id and `{token}` is an HMAC minted
  with `JWT_SECRET`, verified in the Worker before proxying to
  `https://{port}-{id}.{SUPERSERVE_SANDBOX_HOST}`.
- `DISPATCHER` (Workers for Platforms) is bypassed for SuperServe-deployed
  apps; the `containers` binding and `UserAppSandboxService` DO are unused on
  this path but intentionally left in place for rollback.

## Known trade-offs (accepted for v1, PRD §12)

- SuperServe preview ports are publicly reachable by sandbox id on the
  SuperServe edge; the vibesdk token gates only the vibesdk domain. Embedding
  the SuperServe id in the preview URL therefore allows a determined user to
  bypass vibesdk header-stripping by hitting the SuperServe host directly.
- Single region (US-East); per-second billing for always-on deployed apps.
- Deployed apps run the template preview server (`bun run preview`) under the
  monitor-cli supervisor rather than compiling to a Worker.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/superserve/build-template.ts docs/superserve-sandbox.md
git commit -m "feat: superserve template build script and provider runbook"
```

---

### Task 12: Full verification sweep and stub audit

- [ ] **Step 1: No leftover stubs**

Run: `rg -n "not implemented yet" worker/services/sandbox/`
Expected: no output. (Task 4's temporary stubs must all be gone.)

- [ ] **Step 2: Typecheck, lint, tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all green. Fix anything that isn't before proceeding.

- [ ] **Step 3: Acceptance criteria audit (PRD §11)**

| # | Criterion | How verified |
|---|-----------|--------------|
| 1 | End-to-end preview through vibesdk domain | Staging only — requires real SuperServe account + deployed Worker (rollout §13.4). Code path covered by lifecycle + proxy unit tests. |
| 2 | Logs/errors via harness | `superServeOperations.test.ts` (command strings identical to CF provider). Live check in staging. |
| 3 | Static analysis | `superServeOperations.test.ts` + parser tests. |
| 4 | Always-on deploy on stable URL | `superServeDeploy.test.ts` (no `timeoutSeconds`, KV mapping, URL shape). Live check in staging. |
| 5 | All 15 methods, no `any` | Stub audit + `bun run typecheck` + `rg -n ": any|as any|<any>" worker/services/sandbox/superServe* worker/services/sandbox/previewToken.ts worker/services/sandbox/bulkFileScript.ts worker/services/sandbox/staticAnalysisParsers.ts worker/services/sandbox/superServeProxy.ts` returns nothing. |
| 6 | Flag rollback restores old behavior | Non-superserve branches untouched (factory default, request-handler gate, dispatcher fallback); full test suite green. |
| 7 | WebSocket/HMR | Upstream supports it (Go ReverseProxy on the SuperServe edge; workerd fetch-upgrade passthrough in our proxy). Must be verified live in staging — record result in `docs/superserve-sandbox.md`. |

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "test: superserve provider verification fixes"
```

(Skip the commit if the tree is clean.)

---

## Self-Review Notes (already applied)

- PRD §6 method table: all 15 abstract methods have tasks (5: lifecycle ×6, 6: operations ×7, 7: deploy ×1, plus `initialize` in 4). Static template methods inherited (PRD: reuse as-is).
- PRD §7 config: all six env vars in Task 1; `DISPATCHER` bypass documented in Task 11; `containers`/DO bindings intentionally untouched.
- PRD §8 routing: Task 9 (preview) + Task 10 (deployed apps) keep the subdomain contract and header stripping; WS handled in both.
- PRD §9 lifecycle: pause-on-shutdown + `timeoutSeconds` cap (Task 5), always-on deploys + kill-on-delete (Task 7). Capacity errors surface as SDK `RateLimitError` messages through each method's error envelope.
- PRD §10 resilience: exit codes returned not thrown (SDK semantics preserved), SDK auto-resume for exec/files, proxy-level resume for raw preview fetches (Task 9), actionable error strings everywhere.
- Naming: `deployToCloudflareWorkers` kept, documented as misnomer with rename flagged as fast-follow (PRD §6 note).
- Type consistency spot-checks: `SuperServeDeployTarget` used by Tasks 7/9/10; `buildSupervisorStartCommand(instanceId, initCommand, port)` used by Tasks 5/7; `mintPreviewToken(secret, port, sandboxId)` used by Tasks 2/5/9 with the same argument order.

## Execution Notes

- Tasks are ordered by dependency; do not reorder 4→7.
- Steps that say "check X at implementation time" are deliberate: exact type names in `sandboxTypes.ts` (`CodeIssue`, `ListInstancesResponse` element type), `wrangler.test.jsonc` vars/KV bindings, and `SandboxDockerfile` harness build details must be read before editing those spots.
- Never run `wrangler deploy`, the dev server, or the template build script during implementation.

