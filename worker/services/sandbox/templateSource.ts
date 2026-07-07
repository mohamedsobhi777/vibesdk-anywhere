import { getRuntimeEnv } from 'worker/utils/runtimeEnv';
import { TemplateInfo } from './sandboxTypes';

/**
 * Seam for fetching template catalog/zip bytes. Default implementation reads
 * from the R2 binding via getRuntimeEnv() (Workers-only); this module must
 * never import 'cloudflare:workers' or touch bindings at module scope, so
 * BaseSandboxService stays importable under Bun.
 */
export interface TemplateZipSource {
    getCatalog(): Promise<TemplateInfo[]>;
    getZip(name: string, downloadDir?: string): Promise<ArrayBuffer>;
}

/**
 * Default source: reads the template catalog and zip bytes from the
 * TEMPLATES_BUCKET R2 binding. Reads env lazily inside each method — never
 * at module scope — since the binding is poisoned under the Bun runtime.
 */
export class R2TemplateSource implements TemplateZipSource {
    async getCatalog(): Promise<TemplateInfo[]> {
        const env = getRuntimeEnv();
        const response = await env.TEMPLATES_BUCKET.get('template_catalog.json');
        if (response === null) {
            throw new Error(`Failed to fetch template catalog: Template catalog not found`);
        }
        return await response.json() as TemplateInfo[];
    }

    async getZip(name: string, downloadDir?: string): Promise<ArrayBuffer> {
        const env = getRuntimeEnv();
        const downloadUrl = downloadDir ? `${downloadDir}/${name}.zip` : `${name}.zip`;
        const r2Object = await env.TEMPLATES_BUCKET.get(downloadUrl);
        if (!r2Object) {
            throw new Error(`Template '${name}' not found in bucket`);
        }
        return await r2Object.arrayBuffer();
    }
}

/**
 * HTTP-backed source for non-Workers runtimes: fetches the catalog and zip
 * bytes from a static file server rooted at baseUrl.
 */
export function createHttpTemplateSource(baseUrl: string): TemplateZipSource {
    return {
        async getCatalog(): Promise<TemplateInfo[]> {
            const url = `${baseUrl}/template_catalog.json`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch template catalog: HTTP ${response.status}`);
            }
            return await response.json() as TemplateInfo[];
        },
        async getZip(name: string, downloadDir?: string): Promise<ArrayBuffer> {
            const path = downloadDir ? `${downloadDir}/${name}.zip` : `${name}.zip`;
            const url = `${baseUrl}/${path}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Template '${name}' not found: HTTP ${response.status}`);
            }
            return await response.arrayBuffer();
        },
    };
}

let templateSource: TemplateZipSource = new R2TemplateSource();

export function setTemplateSource(source: TemplateZipSource): void {
    templateSource = source;
}

export function getTemplateSource(): TemplateZipSource {
    return templateSource;
}

/** Test-only: restore the default R2-backed source. */
export function resetTemplateSourceForTests(): void {
    templateSource = new R2TemplateSource();
}
