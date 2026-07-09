import { describe, expect, it } from 'vitest';
import { ScreenshotsController } from 'worker/api/controllers/screenshots/controller';
import { ScreenshotSecurity } from 'worker/utils/screenshot-security';
import type { RouteContext } from 'worker/api/types/route-context';

const APP_ID = 'app-abc123';
const FILE = 'latest.png';
const KEY = `screenshots/${APP_ID}/${FILE}`;

interface FakeR2Entry {
    data: Uint8Array;
    httpMetadata?: { contentType?: string };
}

function makeWorkersEnv(seed: Record<string, FakeR2Entry> = {}): Env {
    const store = new Map<string, FakeR2Entry>(Object.entries(seed));
    return {
        JWT_SECRET: 'test-jwt-secret-for-screenshots-controller-tests',
        TEMPLATES_BUCKET: {
            async get(key: string) {
                const entry = store.get(key);
                if (!entry) return null;
                return {
                    body: {},
                    httpMetadata: entry.httpMetadata,
                    async arrayBuffer() {
                        return entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) as ArrayBuffer;
                    },
                };
            },
        },
    } as unknown as Env;
}

function makeContext(): RouteContext {
    return {
        user: null,
        sessionId: null,
        config: {} as RouteContext['config'],
        pathParams: { id: APP_ID, file: FILE },
        queryParams: new URLSearchParams(),
    };
}

/** Mints a real, verifiable screenshot token the same way processAndStoreScreenshot does. */
async function mintToken(env: Env): Promise<string> {
    const security = new ScreenshotSecurity(env);
    const signed = await security.signUrl(`/api/screenshots/${APP_ID}/${FILE}`, APP_ID);
    const token = new URL(signed, 'http://localhost').searchParams.get('token');
    if (!token) throw new Error('failed to mint test token');
    return token;
}

describe('ScreenshotsController.serveScreenshot', () => {
    it('returns the stored bytes with the right content-type for a valid token', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        const env = makeWorkersEnv({ [KEY]: { data: bytes, httpMetadata: { contentType: 'image/png' } } });
        const token = await mintToken(env);

        const request = new Request(`http://localhost/api/screenshots/${APP_ID}/${FILE}?token=${token}`);
        const response = (await ScreenshotsController.serveScreenshot(
            request,
            env,
            {} as ExecutionContext,
            makeContext(),
        )) as unknown as Response;

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('image/png');
        const body = new Uint8Array(await response.arrayBuffer());
        expect(Array.from(body)).toEqual(Array.from(bytes));
    });

    it('rejects a request with an invalid token', async () => {
        const env = makeWorkersEnv({ [KEY]: { data: new Uint8Array([1]), httpMetadata: { contentType: 'image/png' } } });

        const request = new Request(`http://localhost/api/screenshots/${APP_ID}/${FILE}?token=not-a-real-token`);
        const response = (await ScreenshotsController.serveScreenshot(
            request,
            env,
            {} as ExecutionContext,
            makeContext(),
        )) as unknown as Response;

        expect(response.status).toBe(404);
    });

    it('rejects a request with no token', async () => {
        const env = makeWorkersEnv({ [KEY]: { data: new Uint8Array([1]), httpMetadata: { contentType: 'image/png' } } });

        const request = new Request(`http://localhost/api/screenshots/${APP_ID}/${FILE}`);
        const response = (await ScreenshotsController.serveScreenshot(
            request,
            env,
            {} as ExecutionContext,
            makeContext(),
        )) as unknown as Response;

        expect(response.status).toBe(404);
    });

    it('returns 404 for a valid token when the object is missing from storage', async () => {
        const env = makeWorkersEnv();
        const token = await mintToken(env);

        const request = new Request(`http://localhost/api/screenshots/${APP_ID}/${FILE}?token=${token}`);
        const response = (await ScreenshotsController.serveScreenshot(
            request,
            env,
            {} as ExecutionContext,
            makeContext(),
        )) as unknown as Response;

        expect(response.status).toBe(404);
    });

    it('rejects a token minted for a different app id', async () => {
        const env = makeWorkersEnv({ [KEY]: { data: new Uint8Array([1]), httpMetadata: { contentType: 'image/png' } } });
        const security = new ScreenshotSecurity(env);
        const signedForOtherApp = await security.signUrl(`/api/screenshots/${APP_ID}/${FILE}`, 'a-different-app-id');
        const token = new URL(signedForOtherApp, 'http://localhost').searchParams.get('token')!;

        const request = new Request(`http://localhost/api/screenshots/${APP_ID}/${FILE}?token=${token}`);
        const response = (await ScreenshotsController.serveScreenshot(
            request,
            env,
            {} as ExecutionContext,
            makeContext(),
        )) as unknown as Response;

        expect(response.status).toBe(404);
    });
});
