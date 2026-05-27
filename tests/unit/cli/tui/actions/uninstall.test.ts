/**
 * Tests for the uninstall action.
 *
 * Why: uninstall must remove the data dir and call each detected agent
 * handler's uninstall. It must be idempotent (safe when already removed),
 * require confirmation (or --yes flag), and call the correct removers.
 * Tests stub SP7 agent handlers so uninstall tests don't shell out.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub the agent registry so tests don't shell out
vi.mock('../../../../../src/cli/agents/registry.js', () => ({
  detectInstalledHandlers: vi.fn(() => []),
  agentHandlers: [],
}));

import {
  uninstall,
  type UninstallResult,
} from '../../../../../src/cli/tui/actions/uninstall.js';
import { detectInstalledHandlers } from '../../../../../src/cli/agents/registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-sp5-uninstall-'));
  vi.clearAllMocks();
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

function populateDataDir(): void {
  mkdirSync(join(tmpDir, 'embeddings'), { recursive: true });
  writeFileSync(join(tmpDir, 'wigolo.db'), 'data', 'utf-8');
  writeFileSync(join(tmpDir, 'embeddings', 'index.bin'), 'vec', 'utf-8');
}

describe('uninstall — confirmation gate', () => {
  it('does NOT remove data dir when confirmed=false', async () => {
    populateDataDir();
    const result = await uninstall({ dataDir: tmpDir, confirmed: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confirm/i);
    expect(existsSync(join(tmpDir, 'wigolo.db'))).toBe(true);
  });

  it('removes data dir when confirmed=true', async () => {
    populateDataDir();
    const result = await uninstall({ dataDir: tmpDir, confirmed: true });
    expect(result.ok).toBe(true);
    expect(existsSync(tmpDir)).toBe(false);
  });
});

describe('uninstall — agent handler calling', () => {
  it('calls uninstall on all detected handlers', async () => {
    const h1Uninstall = vi.fn().mockResolvedValue({ removed: ['mcp'] });
    const h2Uninstall = vi.fn().mockResolvedValue({ removed: ['config'] });
    vi.mocked(detectInstalledHandlers).mockReturnValueOnce([
      { id: 'agent1', displayName: 'A1', supportsSkills: false, supportsCommands: false,
        detect: () => true, installMcp: vi.fn(), installInstructions: vi.fn(),
        uninstall: h1Uninstall },
      { id: 'agent2', displayName: 'A2', supportsSkills: false, supportsCommands: false,
        detect: () => true, installMcp: vi.fn(), installInstructions: vi.fn(),
        uninstall: h2Uninstall },
    ]);
    populateDataDir();
    const result = await uninstall({ dataDir: tmpDir, confirmed: true });
    expect(result.ok).toBe(true);
    expect(h1Uninstall).toHaveBeenCalledOnce();
    expect(h2Uninstall).toHaveBeenCalledOnce();
  });

  it('includes agent removed items in result', async () => {
    vi.mocked(detectInstalledHandlers).mockReturnValueOnce([
      { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true, supportsCommands: true,
        detect: () => true, installMcp: vi.fn(), installInstructions: vi.fn(),
        uninstall: vi.fn().mockResolvedValue({ removed: ['MCP server (claude mcp remove)', '~/.claude/CLAUDE.md block'] }) },
    ]);
    populateDataDir();
    const result = await uninstall({ dataDir: tmpDir, confirmed: true });
    expect(result.agentResults.length).toBeGreaterThanOrEqual(1);
    const cr = result.agentResults[0]!;
    expect(cr.agentId).toBe('claude-code');
    expect(cr.removed).toContain('MCP server (claude mcp remove)');
  });

  it('continues when one agent uninstall throws (partial success)', async () => {
    vi.mocked(detectInstalledHandlers).mockReturnValueOnce([
      { id: 'agent-fail', displayName: 'Fail', supportsSkills: false, supportsCommands: false,
        detect: () => true, installMcp: vi.fn(), installInstructions: vi.fn(),
        uninstall: vi.fn().mockRejectedValue(new Error('permission denied')) },
    ]);
    populateDataDir();
    const result = await uninstall({ dataDir: tmpDir, confirmed: true });
    // Data dir removal should still succeed
    expect(existsSync(tmpDir)).toBe(false);
    // Agent result shows error
    const cr = result.agentResults[0]!;
    expect(cr.error).toMatch(/permission denied/);
  });
});

describe('uninstall — idempotent', () => {
  it('is safe when data dir does not exist', async () => {
    const nonExistent = join(tmpDir, 'gone');
    const result = await uninstall({ dataDir: nonExistent, confirmed: true });
    expect(result.ok).toBe(true);
  });

  it('second uninstall call is safe (already removed)', async () => {
    populateDataDir();
    await uninstall({ dataDir: tmpDir, confirmed: true });
    // second call
    const result = await uninstall({ dataDir: tmpDir, confirmed: true });
    expect(result.ok).toBe(true);
  });
});

describe('uninstall — path-safety guard (rm -rf footgun prevention)', () => {
  it('refuses to delete the filesystem root', async () => {
    const result = await uninstall({ dataDir: '/', confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.dataDirRemoved).toBe(false);
    expect(result.error).toMatch(/unsafe|refus/i);
  });

  it('refuses to delete the home directory itself', async () => {
    const { homedir } = await import('node:os');
    const result = await uninstall({ dataDir: homedir(), confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.dataDirRemoved).toBe(false);
    expect(result.error).toMatch(/unsafe|refus/i);
  });

  it('refuses to delete an obvious system root (/usr)', async () => {
    const result = await uninstall({ dataDir: '/usr', confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.dataDirRemoved).toBe(false);
  });

  it('does NOT call agent handlers when the data dir is unsafe', async () => {
    const handlerUninstall = vi.fn().mockResolvedValue({ removed: [] });
    vi.mocked(detectInstalledHandlers).mockReturnValueOnce([
      { id: 'a', displayName: 'A', supportsSkills: false, supportsCommands: false,
        detect: () => true, installMcp: vi.fn(), installInstructions: vi.fn(),
        uninstall: handlerUninstall },
    ]);
    const result = await uninstall({ dataDir: '/', confirmed: true });
    expect(result.ok).toBe(false);
    expect(handlerUninstall).not.toHaveBeenCalled();
  });

  it('allows a normal deep data dir (tmp fixture)', async () => {
    populateDataDir();
    const result = await uninstall({ dataDir: tmpDir, confirmed: true });
    expect(result.ok).toBe(true);
  });
});

describe('UninstallResult shape', () => {
  it('result has ok, dataDirRemoved, agentResults, and optional error', async () => {
    populateDataDir();
    const result: UninstallResult = await uninstall({ dataDir: tmpDir, confirmed: true });
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.dataDirRemoved).toBe('boolean');
    expect(Array.isArray(result.agentResults)).toBe(true);
  });
});
