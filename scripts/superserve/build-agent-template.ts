#!/usr/bin/env node
/**
 * Builds (or rebuilds) the SuperServe template used to boot vibesdk's
 * standalone agent process (agent-runtime/src/main.ts) — distinct from the
 * `vibesdk-sandbox` harness template (build-template.ts) that runs generated
 * user apps. This template clones the vibesdk repo, installs Node + bun,
 * and runs `bun install` once at build time so `boot-agent-sandbox.ts` only
 * has to start the already-installed agent process.
 *
 * `Template.create` builds fully server-side from a base image + shell
 * steps; there is no COPY/upload of local files, so the repo is cloned from
 * a public (or reachable) git remote at a pinned ref instead.
 *
 * Required env:
 *   SUPERSERVE_API_KEY   - SuperServe control-plane API key (required)
 * Optional env:
 *   SUPERSERVE_AGENT_TEMPLATE - template name (default: vibesdk-agent)
 *   SUPERSERVE_BASE_URL       - SuperServe API base URL override
 *   VIBESDK_REPO              - git remote to clone (default: cloudflare/vibesdk)
 *   VIBESDK_REF               - branch/tag to clone (default: main)
 *
 * This is a manual/staging tool: it creates a real SuperServe template
 * against the live control plane and is never run in tests or CI. It is
 * verified by type-checking only (see task-12-brief.md, Step 2).
 *
 * Example invocation:
 *   SUPERSERVE_API_KEY=ss_live_... bun run scripts/superserve/build-agent-template.ts
 */

import { Template, type BuildLogEvent } from '@superserve/sdk';

const TEMPLATE_NAME = process.env.SUPERSERVE_AGENT_TEMPLATE ?? 'vibesdk-agent';
const VIBESDK_REPO = process.env.VIBESDK_REPO ?? 'https://github.com/cloudflare/vibesdk';
const VIBESDK_REF = process.env.VIBESDK_REF ?? 'main';
const BASE_URL = process.env.SUPERSERVE_BASE_URL || undefined;
const API_KEY = process.env.SUPERSERVE_API_KEY;

if (!API_KEY) {
	console.error('SUPERSERVE_API_KEY is required to build the SuperServe agent template');
	process.exit(1);
}

function onBuildLog(event: BuildLogEvent): void {
	console.log(`[${event.stream}] ${event.text}`);
}

async function main(apiKey: string): Promise<void> {
	try {
		const existing = await Template.connect(TEMPLATE_NAME, { apiKey, baseUrl: BASE_URL });
		console.log(`Template "${TEMPLATE_NAME}" already exists; deleting before rebuild`);
		await existing.delete();
	} catch {
		// Not found: this is the first build.
	}

	console.log(`Creating template "${TEMPLATE_NAME}" from ${VIBESDK_REPO}@${VIBESDK_REF}`);
	const template = await Template.create({
		apiKey,
		baseUrl: BASE_URL,
		name: TEMPLATE_NAME,
		from: 'ubuntu:24.04',
		vcpu: 4,
		memoryMib: 8192,
		diskMib: 10240,
		steps: [
			{
				run: 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates git unzip procps',
			},
			// Node 22 (some tooling in the vibesdk tree expects node on PATH).
			{ run: 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs' },
			// Bun (primary runtime for the agent process and generated apps).
			{
				run: 'curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx',
			},
			// Clone the vibesdk repo and install once at build time so boot
			// only has to start the agent process, not install dependencies.
			{
				run: `git clone --depth 1 --branch ${VIBESDK_REF} ${VIBESDK_REPO} /opt/vibesdk && cd /opt/vibesdk && bun install`,
			},
			{ run: 'mkdir -p /workspace' },
			{ env: { key: 'VITE_LOGGER_TYPE', value: 'json' } },
		],
		readyCmd: 'test -x /usr/local/bin/bun',
	});

	const info = await template.waitUntilReady({ onLog: onBuildLog });
	console.log(`Template ready: ${info.name} (${info.status})`);
}

main(API_KEY).catch((error: unknown) => {
	console.error('Agent template build failed:', error);
	process.exit(1);
});
