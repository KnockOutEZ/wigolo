import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

const describeE2E = process.env.WIGOLO_E2E === '1' ? describe : describe.skip;

/**
 * Probe the OS for a listener OWNED BY `pid` on any port in the searxng range
 * (8888-8899). Never asserts global port state — only ports held by this
 * specific process. Returns the raw lsof stdout (empty string = no listener).
 */
function lsofSidecarPorts(pid: number): string {
  const r = spawnSync(
    'lsof',
    ['-a', '-p', String(pid), '-iTCP:8888-8899', '-sTCP:LISTEN'],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

/** Direct children of `pid` (pgrep -P), one PID per line. */
function childPids(pid: number): number[] {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describeE2E('SearXNG opt-in gate (E2E)', () => {
  let dataDir: string;
  let child: ChildProcess | null = null;
  let stderrChunks: Buffer[] = [];

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error('Run `npm run build` first — dist/index.js is missing');
    }
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-e2e-'));
    stderrChunks = [];
  });

  afterEach(async () => {
    if (child) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child!.on('close', () => resolve())),
        sleep(2000),
      ]);
      child = null;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('NEGATIVE: default core run performs ZERO sidecar activity', async () => {
    // WHY (D1 acceptance §5.1): a zero-config MCP client on the default core
    // backend must never trip the sidecar — no state file, no install dir, no
    // python child, no port in the sidecar range, and no sidecar/bootstrap
    // chatter on stderr.
    const env = { ...process.env, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'info' };
    delete env.WIGOLO_SEARCH; // default core
    delete env.SEARXNG_URL;

    child = spawn('node', [DIST_ENTRY, 'mcp'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      },
    };
    child.stdin!.write(JSON.stringify(init) + '\n');

    // Let the server settle and any (forbidden) background bootstrap fire.
    await sleep(10_000);

    const pid = child.pid!;

    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng'))).toBe(false);

    // No python child was spawned by wigolo.
    const kids = childPids(pid);
    const pythonKids = kids.filter((kpid) => {
      const cmd = spawnSync('ps', ['-p', String(kpid), '-o', 'comm='], { encoding: 'utf8' });
      return /python/i.test(cmd.stdout ?? '');
    });
    expect(pythonKids).toEqual([]);

    // wigolo holds no listener in the sidecar port range (never global state).
    expect(lsofSidecarPorts(pid)).toBe('');

    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    expect(stderr).not.toMatch(/searxng/i);
    expect(stderr).not.toMatch(/bootstrap/i);
  }, 30_000);

  it('POSITIVE CONTROL: the same lsof probe DETECTS a real listener in the sidecar range', async () => {
    // WHY: proves the NEGATIVE assertions above are not vacuous — the exact
    // probe used to assert "no sidecar" CAN detect a sidecar-range listener when
    // one genuinely exists. We bind a stub HTTP server to a port in 8888-8899
    // (this test process owns it) and assert lsof finds it under our PID. If the
    // probe were broken, the negative test would silently always pass.
    let server: Server | null = null;
    const boundPort = await new Promise<number>((resolve, reject) => {
      const s = createServer((_req, res) => res.end('ok'));
      s.on('error', reject);
      // 8899 sits at the top of the sidecar range the negative probe scans.
      s.listen(8899, '127.0.0.1', () => {
        server = s;
        resolve(8899);
      });
    });

    try {
      expect(boundPort).toBe(8899);
      const detected = lsofSidecarPorts(process.pid);
      // The probe finds THIS process's listener on the sidecar-range port.
      expect(detected).not.toBe('');
      expect(detected).toMatch(/LISTEN/);
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  }, 15_000);
});
