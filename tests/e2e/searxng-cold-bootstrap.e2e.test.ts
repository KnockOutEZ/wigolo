import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../helpers/wait-for.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

const describeE2E = process.env.WIGOLO_E2E === '1' ? describe : describe.skip;

describeE2E('SearXNG cold bootstrap (E2E)', () => {
  let dataDir: string;

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error('Run `npm run build` first — dist/index.js is missing');
    }
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-e2e-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('background bootstrap eventually writes state.json = ready', async () => {
    const child = spawn('node', [DIST_ENTRY, 'mcp'], {
      env: { ...process.env, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      // Send initialize so the MCP server is active
      const init = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      };
      child.stdin.write(JSON.stringify(init) + '\n');

      const ready = await waitFor(() => {
        try {
          const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf-8')) as { status: string };
          return state.status === 'ready';
        } catch { return false; }
      }, { timeoutMs: 120_000, intervalMs: 1000 });

      expect(ready).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
  }, 150_000);
});
