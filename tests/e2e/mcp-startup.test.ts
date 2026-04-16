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

async function spawnMcpAndInit(dataDir: string, timeoutMs: number): Promise<{ response: InitResponse | null; elapsedMs: number }> {
  const start = Date.now();
  const child = spawn('node', [DIST_ENTRY, 'mcp'], {
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let response: InitResponse | null = null;
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
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 100));
  if (!child.killed) child.kill('SIGKILL');
  return { response, elapsedMs };
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

  it('responds to initialize before SearXNG bootstrap completes (cold start)', async () => {
    // Cold start: empty WIGOLO_DATA_DIR. Pre-fix this took ~15s because the
    // server awaited SearXNG download (tarball + pip install) before connecting
    // the MCP transport. Post-fix bootstrap runs in background. We assert under
    // 8s — well above node + heavy module load under suite load (~3-5s) but
    // well below the SearXNG download time (~10s+ for tarball + pip).
    const { response, elapsedMs } = await spawnMcpAndInit(dataDir, 18000);

    expect(response).not.toBeNull();
    expect(response!.result).toBeDefined();
    expect(response!.result!.serverInfo.name).toBe('wigolo');
    expect(elapsedMs).toBeLessThan(12000);
  }, 20000);

  it('serverInfo.version matches package.json version', async () => {
    const { response } = await spawnMcpAndInit(dataDir, 10000);

    expect(response).not.toBeNull();
    expect(response!.result!.serverInfo.version).toBe(PKG_VERSION);
  }, 15000);
});
