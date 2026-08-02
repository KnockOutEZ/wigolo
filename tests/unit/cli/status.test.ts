import { describe, expect, it, vi, beforeEach } from 'vitest';

const { bootstrapStateMock } = vi.hoisted(() => ({
  bootstrapStateMock: vi.fn(),
}));

vi.mock('../../../src/cli/tui/status-cache.js', () => ({
  readCacheStats: vi.fn().mockReturnValue({ pages: 7, bytes: 2 * 1024 * 1024 }),
}));

vi.mock('../../../src/cli/tui/status-python.js', () => ({
  probePythonPackages: vi.fn().mockReturnValue({ reranker: 'ok', embeddings: 'ok' }),
}));

vi.mock('../../../src/cli/tui/status-agents.js', () => ({
  readConnectedAgents: vi.fn().mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', configured: true, path: '/h/.cursor/mcp.json' },
  ]),
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  getBootstrapState: bootstrapStateMock,
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo-data' }),
}));

import { runStatus } from '../../../src/cli/status.js';

beforeEach(() => {
  bootstrapStateMock.mockReset();
  bootstrapStateMock.mockReturnValue({ status: 'ready' });
});

describe('runStatus', () => {
  it('returns 0 and writes a status block to stderr', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
      chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    let code = 99;
    try {
      code = await runStatus([]);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    expect(code).toBe(0);
    const out = chunks.join('');
    expect(out).toContain('wigolo');
    expect(out).toContain('✓ Search engine ready');
    expect(out).toContain('✓ ML reranker installed');
    expect(out).toContain('Cache: 7 pages, 2.0 MB');
    expect(out).toContain('✓ Cursor');
  });

  it('reports searxng: pending when bootstrap state is null', async () => {
    bootstrapStateMock.mockReturnValueOnce(null);

    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
      chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    try {
      await runStatus([]);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    const out = chunks.join('');
    expect(out).toContain('⊘ Search engine: not installed');
  });

  it('reports searxng: failed when bootstrap state is "failed"', async () => {
    bootstrapStateMock.mockReturnValueOnce({ status: 'failed' });

    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
      chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    try {
      await runStatus([]);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    const out = chunks.join('');
    expect(out).toContain('✗ Search engine: failed');
  });

  it('--json emits a machine-readable object on STDOUT (human text stays on stderr)', async () => {
    // WHY (D8): AI-drivable diagnose. --json must put the machine shape on
    // stdout and keep the pretty status block off stdout so a caller can pipe
    // `wigolo status --json | jq`.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = ((s: string | Uint8Array) => {
      stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
      stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    let code = 99;
    try {
      code = await runStatus(['--json']);
    } finally {
      (process.stdout.write as unknown) = origOut;
      (process.stderr.write as unknown) = origErr;
    }

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join(''));
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('version');
    expect(parsed).toHaveProperty('searxng', 'ready');
    expect(parsed).toHaveProperty('reranker', 'ok');
    expect(parsed).toHaveProperty('cache');
    // The pretty block must NOT be on stdout.
    expect(stdoutChunks.join('')).not.toContain('✓ Search engine ready');
  });
});
