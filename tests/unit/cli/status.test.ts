import { describe, expect, it, vi, beforeEach } from 'vitest';

const { bootstrapStateMock } = vi.hoisted(() => ({
  bootstrapStateMock: vi.fn(),
}));

vi.mock('../../../src/cli/tui/status-cache.js', () => ({
  readCacheStats: vi.fn().mockReturnValue({ pages: 7, bytes: 2 * 1024 * 1024 }),
}));

vi.mock('../../../src/cli/tui/status-python.js', () => ({
  probePythonPackages: vi.fn().mockReturnValue({ flashrank: 'ok', trafilatura: 'ok', embeddings: 'ok' }),
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
    expect(out).toContain('✓ SearXNG ready');
    expect(out).toContain('✓ FlashRank installed');
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
    expect(out).toContain('⊘ SearXNG: not installed');
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
    expect(out).toContain('✗ SearXNG: failed');
  });
});
