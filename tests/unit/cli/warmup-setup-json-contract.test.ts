/**
 * --json single-document contract tests for `warmup` and `setup mcp`.
 *
 * These commands ALREADY emit --json; this file pins the house contract so a
 * future refactor cannot regress it: under --json, stdout must be EXACTLY one
 * parseable JSON document, with all human/progress output on stderr. No source
 * change accompanies these tests — they are a guardrail on existing behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- warmup mock scaffold (mirrors tests/unit/cli/warmup.test.ts) so the
//     install phases don't touch the network/filesystem. ---
vi.mock('../../../src/cli/tui/run-command.js', () => ({ runCommand: vi.fn() }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/chromium'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/webkit'), launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn(),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo-warmup', searchBackend: null, searxngUrl: null })),
}));

// The two phases `--all` reaches that the scaffold above does NOT stop, both of which download a
// model from a third party. `warmup.test.ts` — the file this scaffold is copied from — mocks both
// (:50, :57); this file took the rest of the scaffold and left these out, so the mock comment above
// was true of everything except the two heaviest phases.
//
// It was invisible for the usual reason: `getConfig` is mocked to a FIXED `/tmp/test-wigolo-warmup`
// rather than the per-worker test home, so once any run populates that path every later run on that
// machine is a cache hit and never egresses. A cold runner has nothing there, downloads the
// cross-encoder from huggingface.co, and reds — which is exactly what CI did on all three platforms
// while this suite was green locally. Verified by deleting that directory and re-running: 18
// outbound connections, the same count CI reported.
//
// `existsSync` being mocked to `true` above is why only ONE of the two fires: the embeddings phase
// probes the filesystem and skips, while the cross-encoder loader does its own I/O and downloads
// anyway.
//
// So these two mocks are NOT equally load-bearing, and the difference is recorded rather than
// implied. Removing the rerank mock and re-running cold reds immediately (18 connections again).
// Removing the fastembed one changes nothing today — measured, 0 failures — because `existsSync`
// is covering it. It is kept anyway, as insurance rather than as proven-necessary: the embeddings
// phase is one edit to that `existsSync` mock away from downloading, and a reader who sees only
// the rerank mock would reasonably conclude the embeddings phase is safe on its own merits, which
// it is not.
const rerankMock = vi.fn().mockResolvedValue([{ id: '0', score: 0.5 }]);
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: rerankMock,
  })),
}));

vi.mock('../../../src/embedding/fastembed-provider.js', () => {
  const FastembedEmbedProvider = vi.fn(function (this: Record<string, unknown>) {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
    this.warmup = vi.fn().mockResolvedValue(undefined);
    this.embed = vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]);
  });
  return { FastembedEmbedProvider };
});

// --- setup-mcp mock scaffold (mirrors setup-mcp-non-interactive.test.ts). ---
const { detectAgentsMock, selectAgentsMock, applyConfigsMock, printAddMcpBannerMock } = vi.hoisted(() => ({
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  printAddMcpBannerMock: vi.fn(),
}));
vi.mock('../../../src/cli/tui/agents.js', () => ({ detectAgents: detectAgentsMock }));
vi.mock('../../../src/cli/tui/select-agents.js', () => ({
  selectAgents: selectAgentsMock,
  NotTtyError: class NotTtyError extends Error {},
}));
vi.mock('../../../src/cli/tui/config-writer.js', () => ({ applyConfigs: applyConfigsMock }));
vi.mock('../../../src/cli/tui/banner.js', () => ({ printAddMcpBanner: printAddMcpBannerMock }));

import { runWarmup } from '../../../src/cli/warmup.js';
import { runSetupMcp } from '../../../src/cli/setup-mcp.js';
import { runCommand } from '../../../src/cli/tui/run-command.js';

function capture(): { stdout: string[]; restore: () => void } {
  const stdout: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write; // swallow human output
  return { stdout, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

function expectSingleJsonDoc(text: string): unknown {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe('warmup --json single-doc contract', () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: '', stderr: '' } as never);
  });

  it('writes exactly one parseable JSON document to stdout', async () => {
    const cap = capture();
    try {
      await runWarmup(['--json']);
    } finally {
      cap.restore();
    }
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { browserEngine?: string };
    // The warmup result always carries a browser phase outcome — under the
    // capability-named key, not the library name.
    expect(doc).toHaveProperty('browserEngine');
  });

  it('emits capability-named keys, not implementation library names', async () => {
    // WHY (A1): the --json output is a machine-facing contract. Library names
    // (playwright/searxng) leak the implementation and violate the
    // capability-language rule the OpenAPI surface already enforces. The JSON
    // must carry `browserEngine`/`searchSidecar` and must not mention the libs.
    const cap = capture();
    try {
      await runWarmup(['--all', '--json']);
    } finally {
      cap.restore();
    }
    const raw = cap.stdout.join('').trim();
    expect(raw).not.toMatch(/playwright|searxng/i);
    const doc = expectSingleJsonDoc(raw) as Record<string, unknown>;
    expect(doc).toHaveProperty('browserEngine');
    expect(doc).toHaveProperty('searchSidecar');
    // Old library-named keys must be gone from the machine contract.
    expect(doc).not.toHaveProperty('playwright');
    expect(doc).not.toHaveProperty('searxng');
  });
});

describe('setup mcp --json single-doc contract', () => {
  beforeEach(() => {
    detectAgentsMock.mockReset().mockReturnValue([
      { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
    ]);
    selectAgentsMock.mockReset().mockResolvedValue([]);
    applyConfigsMock.mockReset().mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/h/.cursor/mcp.json' },
    ]);
  });

  it('writes exactly one parseable JSON summary to stdout', async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runSetupMcp(['mcp', '--non-interactive', '--agents=cursor', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { status: string; agents: unknown[] };
    expect(doc.status).toBe('ok');
    expect(Array.isArray(doc.agents)).toBe(true);
  });
});
