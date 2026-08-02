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
});
