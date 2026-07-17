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
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { playwright?: string };
    // The warmup result always carries a browser phase outcome.
    expect(doc).toHaveProperty('playwright');
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
