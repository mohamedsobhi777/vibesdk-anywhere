import { describe, expect, it } from 'vitest';
import { GitVersionControl, type GitFsPromises } from 'worker/agents/git';

function makeErrno(code: string): NodeJS.ErrnoException {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

function createFakeFs(): { fs: GitFsPromises; calls: string[] } {
    const calls: string[] = [];
    const files = new Map<string, Uint8Array>();
    const dirs = new Set<string>(['']);

    const fs: GitFsPromises = {
        readFile: async (p: string) => {
            calls.push(`readFile:${p}`);
            const hit = files.get(p);
            if (!hit) throw makeErrno('ENOENT');
            return hit;
        },
        writeFile: async (p: string, d: Uint8Array | string) => {
            calls.push(`writeFile:${p}`);
            files.set(p, typeof d === 'string' ? new TextEncoder().encode(d) : d);
        },
        unlink: async (p: string) => {
            calls.push(`unlink:${p}`);
            files.delete(p);
        },
        mkdir: async (p: string) => {
            calls.push(`mkdir:${p}`);
            dirs.add(p);
        },
        readdir: async (p: string) => {
            calls.push(`readdir:${p}`);
            if (!dirs.has(p)) throw makeErrno('ENOENT');
            return [];
        },
        stat: async (p: string) => {
            calls.push(`stat:${p}`);
            throw makeErrno('ENOENT');
        },
        lstat: async (p: string) => {
            calls.push(`lstat:${p}`);
            throw makeErrno('ENOENT');
        },
        rmdir: async (p: string) => {
            calls.push(`rmdir:${p}`);
            dirs.delete(p);
        },
        symlink: async (target: string, p: string) => {
            calls.push(`symlink:${p}`);
            files.set(p, new TextEncoder().encode(target));
        },
        readlink: async (p: string) => {
            calls.push(`readlink:${p}`);
            const hit = files.get(p);
            if (!hit) throw makeErrno('ENOENT');
            return new TextDecoder().decode(hit);
        },
        chmod: async (_p: string, _mode: number) => {
            calls.push(`chmod:${_p}`);
        },
        rename: async (oldPath: string, newPath: string) => {
            calls.push(`rename:${oldPath}->${newPath}`);
            const hit = files.get(oldPath);
            if (hit) {
                files.set(newPath, hit);
                files.delete(oldPath);
            }
        },
    };

    return { fs, calls };
}

describe('GitVersionControl fs injection', () => {
    it('accepts an injected fs and never constructs SqliteFS (sql stays untouched)', () => {
        const { fs } = createFakeFs();

        // sql is `null as never`: if the constructor still built `new SqliteFS(sql)`
        // and called `.init()`, it would throw immediately (SqlExecutor is not callable
        // on null). Construction succeeding proves the default SqliteFS path was skipped
        // entirely in favor of the injected fs.
        const git = new GitVersionControl(null as never, { fs });

        expect(git).toBeDefined();
    });

    it('uses the injected fs for git operations instead of the default SqliteFS-backed fs', async () => {
        const { fs, calls } = createFakeFs();
        const git = new GitVersionControl(null as never, { fs });

        await git.init();

        // git.init() must have driven writes through the injected fs, not SqliteFS.
        expect(calls.length).toBeGreaterThan(0);
    });

    it('falls back to the default SqliteFS-backed fs when no override is provided', () => {
        // This exercises the untouched default path: a real SqlExecutor is required,
        // and GitVersionControl must construct its own SqliteFS exactly as before.
        const rows: unknown[] = [];
        const sql = (() => rows) as unknown as ConstructorParameters<typeof GitVersionControl>[0];
        const git = new GitVersionControl(sql);

        expect(git).toBeDefined();
        expect(git.fs).toBeDefined();
        // Default fs must still expose SqliteFS-only members relied on elsewhere
        // (e.g. codingAgent.ts calls `this.git.fs.exportGitObjects()`).
        expect(typeof git.fs.exportGitObjects).toBe('function');
        expect(typeof git.fs.getStorageStats).toBe('function');
    });
});
