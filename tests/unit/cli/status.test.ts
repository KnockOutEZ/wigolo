import { describe, expect, it, vi, beforeEach } from 'vitest';

const { bootstrapStateMock, cfg } = vi.hoisted(() => ({
  bootstrapStateMock: vi.fn(),
  // Mutable so one case can point `status` at a data dir it controls without the other cases
  // acquiring a filesystem dependency they do not need.
  cfg: { dataDir: '/tmp/wigolo-data' },
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
  getConfig: () => cfg,
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatus } from '../../../src/cli/status.js';
import { bumpTierOccupancy } from '../../../src/fetch/tier-occupancy.js';
import { resetBrowserTierAnnouncements, BROWSER_TIER_ENV } from '../../../src/fetch/browser-tier.js';

beforeEach(() => {
  cfg.dataDir = '/tmp/wigolo-data';
  bootstrapStateMock.mockReset();
  bootstrapStateMock.mockReturnValue({ status: 'ready' });
});

function captureStderr(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
    chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
    return true;
  });
  return run().then(
    () => { (process.stderr.write as unknown) = orig; return chunks.join(''); },
    (e) => { (process.stderr.write as unknown) = orig; throw e; },
  );
}

describe('runStatus — tier occupancy (D-S10-4)', () => {
  it('renders the occupancy row for the tier this host actually resolved to', async () => {
    // WHY end-to-end rather than against the formatter: the formatter is already covered, and a
    // correctly-formatted section that `status` never asks for is exactly the failure mode
    // D-S10-4 is about — an instrument whose numbers nobody can reach. This drives the real
    // wiring, and it forces the no-display tier through the resolver's documented override so
    // the case does not silently become "whatever the test runner's own machine is".
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-status-occupancy-'));
    const prevTier = process.env[BROWSER_TIER_ENV];
    cfg.dataDir = dir;
    process.env[BROWSER_TIER_ENV] = 'no-display';
    resetBrowserTierAnnouncements();
    try {
      bumpTierOccupancy('no-display', 'browser', dir);
      bumpTierOccupancy('desktop', 'http', dir);
      const out = await captureStderr(() => runStatus([]));
      // The no-display row, and NOT the desktop row that also has data on disk.
      expect(out).toContain('Rungs used: 0 direct, 0 hardened, 1 browser engine, 0 attended session');
    } finally {
      if (prevTier === undefined) delete process.env[BROWSER_TIER_ENV];
      else process.env[BROWSER_TIER_ENV] = prevTier;
      resetBrowserTierAnnouncements();
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
