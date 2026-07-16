import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the worktree root's dist/index.js RELATIVE to this SDK package, and
 * assert it lives inside the checkout. A loud failure here beats a silent test
 * against some stray global install.
 */
export function resolveDistEntry(): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // tests/
  const sdkRoot = resolve(here, '..'); // sdks/typescript
  const repoRoot = resolve(sdkRoot, '..', '..'); // worktree root
  const dist = join(repoRoot, 'dist', 'index.js');
  if (!dist.startsWith(repoRoot)) {
    throw new Error(`Resolved dist entry ${dist} is not inside the checkout ${repoRoot}.`);
  }
  if (!existsSync(dist)) {
    throw new Error(
      `Missing ${dist}. Run \`npm run build\` at the repo root before running SDK integration tests.`,
    );
  }
  return dist;
}

/** The default spawn command the embedded local mode should use in tests. */
export function distServeCommand(): string[] {
  return [process.execPath, resolveDistEntry()];
}

/** Allocate a free loopback TCP port (bind :0, read, close). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
  });
}

/**
 * Create ONE data dir for a suite run, seeding the model caches from ~/.wigolo
 * so spawned serves reuse local models instead of re-downloading them.
 */
export function makeSeededDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wigolo-sdk-data-'));
  for (const sub of ['fastembed', 'transformers']) {
    const src = join(homedir(), '.wigolo', sub);
    if (existsSync(src)) {
      try {
        cpSync(src, join(dir, sub), { recursive: true });
      } catch {
        /* best effort — a cold model download still works, just slower */
      }
    }
  }
  return dir;
}

export interface SpawnedServe {
  child: ChildProcess;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

export interface SpawnServeOptions {
  port: number;
  dataDir: string;
  token?: string;
  extraEnv?: Record<string, string>;
}

/** Spawn the real dist serve on a loopback port; resolve once /health is 200. */
export async function spawnServe(opts: SpawnServeOptions): Promise<SpawnedServe> {
  const dist = resolveDistEntry();
  const env: Record<string, string | undefined> = {
    ...process.env,
    WIGOLO_DATA_DIR: opts.dataDir,
    ...opts.extraEnv,
  };
  // Never inherit ambient WIGOLO_* config beyond what we set explicitly.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('WIGOLO_') &&
      key !== 'WIGOLO_DATA_DIR' &&
      !(opts.extraEnv && key in opts.extraEnv) &&
      !(opts.token !== undefined && key === 'WIGOLO_API_TOKEN')
    ) {
      delete env[key];
    }
  }
  if (opts.token !== undefined) env.WIGOLO_API_TOKEN = opts.token;
  else delete env.WIGOLO_API_TOKEN;

  const child = spawn(
    process.execPath,
    [dist, 'serve', '--port', String(opts.port), '--host', '127.0.0.1'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const stderr: string[] = [];
  child.stderr?.on('data', (b: Buffer) => {
    stderr.push(b.toString('utf-8'));
    if (stderr.length > 80) stderr.shift();
  });

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const headers: Record<string, string> = opts.token
    ? { Authorization: `Bearer ${opts.token}` }
    : {};
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`serve exited early (code ${child.exitCode}):\n${stderr.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`serve never became healthy on ${baseUrl}:\n${stderr.join('')}`);
  }

  return {
    child,
    port: opts.port,
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const stopDeadline = Date.now() + 6000;
      while (child.exitCode === null && Date.now() < stopDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
