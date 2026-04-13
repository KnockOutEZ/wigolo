import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../helpers/wait-for.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

const describeE2E = process.env.WIGOLO_E2E === '1' ? describe : describe.skip;

describeE2E('SearXNG cold bootstrap (E2E)', () => {
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
        new Promise<void>(resolve => child!.on('close', resolve)),
        new Promise<void>(resolve => setTimeout(resolve, 2000)),
      ]);
      child = null;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('background bootstrap eventually writes state.json = ready', async () => {
    child = spawn('node', [DIST_ENTRY, 'mcp'], {
      env: { ...process.env, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // Send initialize so the MCP server is active
    const init = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
    };
    child.stdin!.write(JSON.stringify(init) + '\n');

    let ready: boolean;
    try {
      ready = await waitFor(() => {
        try {
          const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf-8')) as { status: string };
          return state.status === 'ready';
        } catch { return false; }
      }, { timeoutMs: 120_000, intervalMs: 1000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg + '\n\nChild stderr:\n' + Buffer.concat(stderrChunks).toString('utf8'));
    }

    expect(ready).toBe(true);
  }, 150_000);
});
