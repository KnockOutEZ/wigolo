import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PKG_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

interface InitResponse {
  result?: { protocolVersion: string; serverInfo: { name: string; version: string } };
  error?: unknown;
  jsonrpc: string;
  id: number;
}

async function spawnMcpAndInit(
  dataDir: string,
  timeoutMs: number,
  settleMs = 0,
): Promise<{ response: InitResponse | null; elapsedMs: number; stderr: string }> {
  const start = Date.now();
  const child = spawn('node', [DIST_ENTRY, 'mcp'], {
    // LOG_LEVEL=info so the lazy model-load info line would be visible IF it
    // ever fired at boot — the assertion below proves it does not.
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'info' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  let response: InitResponse | null = null;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const responsePromise = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            response = parsed as InitResponse;
            resolve();
          }
        } catch {}
      }
    });
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  }) + '\n');

  await Promise.race([
    responsePromise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`init timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);

  const elapsedMs = Date.now() - start;
  // Optionally let the process idle so any boot-time background work (which
  // must NOT include a model load) has a chance to emit its stderr line.
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 100));
  if (!child.killed) child.kill('SIGKILL');
  return { response, elapsedMs, stderr };
}

interface ToolsListResponse {
  result?: { tools: { name: string; description?: string }[] };
  error?: unknown;
}

/**
 * Boot the real server, complete the handshake, and ask it for its tool list.
 *
 * EXTRACT §10: the source-level negative grep added with the deletion proves no `studio_` name is
 * WRITTEN in the schema files. It cannot prove what the server ANSWERS with — a provider
 * registered at runtime, a dynamically-named tool, or a stale entry reaching the registry from a
 * built artifact would all pass the grep and still put the name on the wire. So this asks the
 * process itself, over the same transport a client uses.
 */
async function spawnMcpAndListTools(dataDir: string, timeoutMs: number): Promise<ToolsListResponse> {
  const child = spawn('node', [DIST_ENTRY, 'mcp'], {
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const pending = new Map<number, (v: unknown) => void>();
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { id?: number };
        if (typeof parsed.id === 'number') {
          pending.get(parsed.id)?.(parsed);
          pending.delete(parsed.id);
        }
      } catch {}
    }
  });

  const send = (msg: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const request = (id: number, method: string, params: unknown = {}): Promise<unknown> => {
    const answered = new Promise<unknown>((resolve) => pending.set(id, resolve));
    send({ jsonrpc: '2.0', id, method, params });
    return Promise.race([
      answered,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${method} timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  };

  try {
    await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return (await request(2, 'tools/list')) as ToolsListResponse;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    if (!child.killed) child.kill('SIGKILL');
  }
}

describe('e2e: MCP server startup', () => {
  let dataDir: string;

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      execSync('npm run build', { cwd: REPO_ROOT, stdio: 'pipe' });
    }
  }, 60000);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-test-'));
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('responds to initialize before background bootstrap completes (cold start)', async () => {
    // Cold start: empty WIGOLO_DATA_DIR. Pre-fix this took 30s+ because the
    // server awaited a search-engine sidecar download before connecting the
    // MCP transport. Post-fix that bootstrap is opt-in / runs in background.
    // The remaining startup cost is heavy module load + plugin scan — the
    // embedding model is now loaded lazily on first use (D2), NOT at boot, so
    // it no longer contributes to startup latency. Locally this lands
    // ~5-10s and on slow CI runners ~15-20s. We assert under 25s.
    const { response, elapsedMs } = await spawnMcpAndInit(dataDir, 30000);

    expect(response).not.toBeNull();
    expect(response!.result).toBeDefined();
    expect(response!.result!.serverInfo.name).toBe('wigolo');
    expect(elapsedMs).toBeLessThan(25000);
  }, 35000);

  it('does not load the embedding model at boot (no model-load stderr line)', async () => {
    // Lazy embedding (D2): boot provisions the vector store + runs migrations
    // but must NOT touch the ONNX runtime. The one-line load message only
    // appears on first real embed/find_similar use — never during startup,
    // even after a short idle settle.
    const { response, stderr } = await spawnMcpAndInit(dataDir, 30000, 3000);

    expect(response).not.toBeNull();
    expect(stderr).not.toMatch(/loading embedding model/i);
    expect(stderr).not.toMatch(/embedding provider verified/i);
    expect(stderr).not.toMatch(/Loading embedding model/);
    expect(stderr).not.toMatch(/Embedding model ready/);
  }, 40000);

  it('serverInfo.version matches package.json version', async () => {
    const { response } = await spawnMcpAndInit(dataDir, 25000);

    expect(response).not.toBeNull();
    expect(response!.result!.serverInfo.version).toBe(PKG_VERSION);
  }, 30000);

  describe('runtime tool surface after the studio extraction', () => {
    it('answers tools/list with a non-empty list, so the guard below has something to guard', async () => {
      // An assertion over an empty list is trivially true. This case forces the condition the next
      // one depends on: the server really did register its tools before we checked their names.
      const listed = await spawnMcpAndListTools(dataDir, 30000);
      expect(listed.error).toBeUndefined();
      expect(listed.result!.tools.length).toBeGreaterThan(0);
    }, 40000);

    it('exposes no tool whose name starts with studio_', async () => {
      // The extraction's user-visible promise: the domain layer left, and the wire surface a
      // client sees left with it. Asserted against what the running server ANSWERS, because the
      // source-level grep cannot see a runtime-registered provider or a stale built artifact.
      const listed = await spawnMcpAndListTools(dataDir, 30000);
      const offenders = listed.result!.tools.map((t) => t.name).filter((n) => n.startsWith('studio_'));
      expect(offenders).toEqual([]);
    }, 40000);

    it('names no studio tool in any tool DESCRIPTION either', async () => {
      // A tool renamed but still described in terms of `studio_spawn` leaves the old surface
      // discoverable to a model reading the list, which is the half a name-only check misses.
      const listed = await spawnMcpAndListTools(dataDir, 30000);
      const described = listed.result!.tools
        .filter((t) => (t.description ?? '').includes('studio_'))
        .map((t) => t.name);
      expect(described).toEqual([]);
    }, 40000);
  });
});
