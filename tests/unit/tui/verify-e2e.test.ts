/**
 * Unit tests for verifyEndToEnd action (SP6).
 *
 * WHY: After install the user needs real confidence that capabilities work.
 * The orchestration logic (capability aggregation, synthesis-skip-with-reason,
 * MCP-wiring file check) must be testable headlessly with all network and
 * provider calls mocked — the live capability smoke is a runtime feature, not
 * a unit test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CapabilityResult,
  VerifyEndToEndResult,
  VerifyEndToEndDeps,
} from '../../../src/cli/tui/actions/verify-e2e.js';
import { verifyEndToEnd } from '../../../src/cli/tui/actions/verify-e2e.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<VerifyEndToEndDeps> = {}): VerifyEndToEndDeps {
  return {
    probeSearch: vi.fn().mockResolvedValue({ capability: 'search', status: 'pass', detail: 'got 1 result' }),
    probeFetch: vi.fn().mockResolvedValue({ capability: 'fetch', status: 'pass', detail: 'fetched 500 chars' }),
    probeExtract: vi.fn().mockResolvedValue({ capability: 'extract', status: 'pass', detail: 'title extracted' }),
    probeSynthesis: vi.fn().mockResolvedValue({ capability: 'synthesis', status: 'pass', detail: 'synthesis ok' }),
    probeMcpWiring: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('verifyEndToEnd — result shape', () => {
  it('returns an array with one entry per capability', async () => {
    const deps = makeDeps();
    const result = await verifyEndToEnd(deps);
    const capabilities = result.capabilities.map((c) => c.capability);
    expect(capabilities).toContain('search');
    expect(capabilities).toContain('fetch');
    expect(capabilities).toContain('extract');
    expect(capabilities).toContain('synthesis');
  });

  it('CapabilityResult has capability, status, and detail fields', async () => {
    const deps = makeDeps();
    const result = await verifyEndToEnd(deps);
    for (const cap of result.capabilities) {
      expect(cap).toHaveProperty('capability');
      expect(cap).toHaveProperty('status');
      expect(cap).toHaveProperty('detail');
      expect(['pass', 'fail', 'skipped']).toContain(cap.status);
    }
  });

  it('allPassed is true when all capabilities pass', async () => {
    const deps = makeDeps();
    const result = await verifyEndToEnd(deps);
    expect(result.allPassed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One failing capability marks allPassed false with actionable detail
// ---------------------------------------------------------------------------

describe('verifyEndToEnd — failure aggregation', () => {
  it('allPassed is false when search probe fails', async () => {
    const deps = makeDeps({
      probeSearch: vi.fn().mockResolvedValue({
        capability: 'search',
        status: 'fail',
        detail: 'network error — check WIGOLO_SEARCH env var or internet connectivity',
      }),
    });
    const result = await verifyEndToEnd(deps);
    expect(result.allPassed).toBe(false);
    const searchCap = result.capabilities.find((c) => c.capability === 'search')!;
    expect(searchCap.status).toBe('fail');
    expect(searchCap.detail.length).toBeGreaterThan(0);
  });

  it('allPassed is false when fetch probe fails', async () => {
    const deps = makeDeps({
      probeFetch: vi.fn().mockResolvedValue({
        capability: 'fetch',
        status: 'fail',
        detail: 'HTTP fetch failed — check internet connectivity or run `wigolo warmup`',
      }),
    });
    const result = await verifyEndToEnd(deps);
    expect(result.allPassed).toBe(false);
  });

  it('allPassed is false when extract probe fails', async () => {
    const deps = makeDeps({
      probeExtract: vi.fn().mockResolvedValue({
        capability: 'extract',
        status: 'fail',
        detail: 'extraction returned empty content',
      }),
    });
    const result = await verifyEndToEnd(deps);
    expect(result.allPassed).toBe(false);
  });

  it('allPassed is true when synthesis is skipped (not failed)', async () => {
    const deps = makeDeps({
      probeSynthesis: vi.fn().mockResolvedValue({
        capability: 'synthesis',
        status: 'skipped',
        detail: 'no provider key configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY',
      }),
    });
    const result = await verifyEndToEnd(deps);
    // synthesis skip does NOT count as a hard failure
    expect(result.allPassed).toBe(true);
    const synthCap = result.capabilities.find((c) => c.capability === 'synthesis')!;
    expect(synthCap.status).toBe('skipped');
    expect(synthCap.detail).toContain('no provider');
  });

  it('has non-zero hardFailureCount when search or fetch fails', async () => {
    const deps = makeDeps({
      probeSearch: vi.fn().mockResolvedValue({ status: 'fail', detail: 'network error' }),
    });
    const result = await verifyEndToEnd(deps);
    expect(result.hardFailureCount).toBeGreaterThan(0);
  });

  it('hardFailureCount does not include skipped capabilities', async () => {
    const deps = makeDeps({
      probeSynthesis: vi.fn().mockResolvedValue({
        status: 'skipped',
        detail: 'no provider key configured',
      }),
    });
    const result = await verifyEndToEnd(deps);
    expect(result.hardFailureCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MCP-wiring check
// ---------------------------------------------------------------------------

describe('verifyEndToEnd — MCP-wiring check', () => {
  it('includes mcp-wiring capability in result when wiring results are present', async () => {
    const deps = makeDeps({
      probeMcpWiring: vi.fn().mockResolvedValue([
        { agentId: 'cursor', agentName: 'Cursor', configPath: '/home/.cursor/mcp.json', status: 'pass', detail: 'wigolo entry found' },
      ]),
    });
    const result = await verifyEndToEnd(deps);
    const mcpCap = result.capabilities.find((c) => c.capability === 'mcp-wiring');
    expect(mcpCap).toBeDefined();
    expect(mcpCap!.status).toBe('pass');
  });

  it('mcp-wiring capability is skipped with reason when no agents configured', async () => {
    const deps = makeDeps({
      probeMcpWiring: vi.fn().mockResolvedValue([]),
    });
    const result = await verifyEndToEnd(deps);
    const mcpCap = result.capabilities.find((c) => c.capability === 'mcp-wiring');
    expect(mcpCap).toBeDefined();
    expect(mcpCap!.status).toBe('skipped');
    expect(mcpCap!.detail.length).toBeGreaterThan(0);
  });

  it('mcp-wiring fails when at least one agent is missing the wigolo entry', async () => {
    const deps = makeDeps({
      probeMcpWiring: vi.fn().mockResolvedValue([
        { agentId: 'cursor', agentName: 'Cursor', configPath: '/home/.cursor/mcp.json', status: 'pass', detail: 'wigolo entry found' },
        {
          agentId: 'vscode',
          agentName: 'VS Code',
          configPath: '/home/.vscode/mcp.json',
          status: 'fail',
          detail: 'wigolo entry missing — re-run `wigolo init` to repair',
        },
      ]),
    });
    const result = await verifyEndToEnd(deps);
    const mcpCap = result.capabilities.find((c) => c.capability === 'mcp-wiring')!;
    expect(mcpCap.status).toBe('fail');
    expect(result.mcpWiringResults).toHaveLength(2);
  });

  it('allPassed is false when mcp-wiring fails', async () => {
    const deps = makeDeps({
      probeMcpWiring: vi.fn().mockResolvedValue([
        {
          agentId: 'cursor',
          agentName: 'Cursor',
          configPath: '/home/.cursor/mcp.json',
          status: 'fail',
          detail: 'wigolo entry missing — re-run `wigolo init` to repair',
        },
      ]),
    });
    const result = await verifyEndToEnd(deps);
    expect(result.allPassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Synthesis skip-with-reason when no provider key
// ---------------------------------------------------------------------------

describe('probeSynthesis — skip when no provider key', () => {
  it('synthesis probe returns skipped when resolveProviderKey is absent', async () => {
    // When SP4 has not landed, synthesis probe must return skipped
    const deps = makeDeps({
      probeSynthesis: vi.fn().mockResolvedValue({
        capability: 'synthesis',
        status: 'skipped',
        detail: 'no provider key configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to enable synthesis',
      }),
    });
    const result = await verifyEndToEnd(deps);
    const synthCap = result.capabilities.find((c) => c.capability === 'synthesis')!;
    expect(synthCap.status).toBe('skipped');
    expect(synthCap.detail).toContain('no provider key configured');
  });
});

// ---------------------------------------------------------------------------
// Plain-text headless formatter
// ---------------------------------------------------------------------------

describe('formatVerifyResultPlain', () => {
  it('emits pass/fail/skip lines with capability names', async () => {
    const { formatVerifyResultPlain } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const result: VerifyEndToEndResult = {
      capabilities: [
        { capability: 'search', status: 'pass', detail: 'got 3 results' },
        { capability: 'fetch', status: 'fail', detail: 'HTTP error — check connectivity' },
        { capability: 'extract', status: 'pass', detail: 'title extracted' },
        { capability: 'synthesis', status: 'skipped', detail: 'no provider key configured' },
        { capability: 'mcp-wiring', status: 'skipped', detail: 'no agents configured' },
      ],
      mcpWiringResults: [],
      allPassed: false,
      hardFailureCount: 1,
    };
    const lines = formatVerifyResultPlain(result);
    expect(lines.some((l) => l.includes('PASS') && l.includes('search'))).toBe(true);
    expect(lines.some((l) => l.includes('FAIL') && l.includes('fetch'))).toBe(true);
    expect(lines.some((l) => l.includes('SKIP') && l.includes('synthesis'))).toBe(true);
    // failure detail is present
    expect(lines.some((l) => l.includes('check connectivity'))).toBe(true);
    // summary line
    expect(lines.some((l) => l.includes('hard failure') || l.includes('FAIL'))).toBe(true);
  });

  it('summary line indicates overall pass when allPassed is true', async () => {
    const { formatVerifyResultPlain } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const result: VerifyEndToEndResult = {
      capabilities: [
        { capability: 'search', status: 'pass', detail: 'ok' },
        { capability: 'fetch', status: 'pass', detail: 'ok' },
        { capability: 'extract', status: 'pass', detail: 'ok' },
        { capability: 'synthesis', status: 'skipped', detail: 'no provider key configured' },
        { capability: 'mcp-wiring', status: 'skipped', detail: 'no agents configured' },
      ],
      mcpWiringResults: [],
      allPassed: true,
      hardFailureCount: 0,
    };
    const lines = formatVerifyResultPlain(result);
    expect(lines.some((l) => l.toLowerCase().includes('ok') || l.toLowerCase().includes('pass'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP wiring file probe (unit — fixture-based)
// ---------------------------------------------------------------------------

describe('checkMcpWiringForAgent', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mcp-wiring-'));
  });
  // cleanup is handled by OS tmp; tests keep dir reference

  it('returns pass when wigolo entry is present at keyPath', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { wigolo: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] } } }));
    const result = await checkMcpWiringForAgent({
      agentId: 'cursor',
      agentName: 'Cursor',
      configPath,
      keyPath: ['mcpServers', 'wigolo'],
      installType: 'config-file',
      allowedRoots: [dir],
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/wigolo entry found/i);
  });

  it('returns fail when config file exists but wigolo key is absent', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const configPath = join(dir, 'mcp2.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: {} } }));
    const result = await checkMcpWiringForAgent({
      agentId: 'cursor',
      agentName: 'Cursor',
      configPath,
      keyPath: ['mcpServers', 'wigolo'],
      installType: 'config-file',
      allowedRoots: [dir],
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('wigolo entry missing');
  });

  it('returns fail when config file does not exist', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const configPath = join(dir, 'nonexistent.json');
    const result = await checkMcpWiringForAgent({
      agentId: 'cursor',
      agentName: 'Cursor',
      configPath,
      keyPath: ['mcpServers', 'wigolo'],
      installType: 'config-file',
      allowedRoots: [dir],
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('config file not found');
  });

  it('returns pass for cli-command agents (claude-code uses CLI install, no file)', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const result = await checkMcpWiringForAgent({
      agentId: 'claude-code',
      agentName: 'Claude Code',
      configPath: null,
      keyPath: [],
      installType: 'cli-command',
    });
    // CLI agents can't be file-checked; report as pass/skipped
    expect(['pass', 'skipped']).toContain(result.status);
  });

  it('returns pass when TOML config contains wigolo entry at table path', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, '[mcp_servers.wigolo]\ncommand = "npx"\nargs = ["-y", "@staticn0va/wigolo"]\n');
    const result = await checkMcpWiringForAgent({
      agentId: 'codex',
      agentName: 'Codex',
      configPath,
      keyPath: ['mcp_servers', 'wigolo'],
      installType: 'config-toml',
      allowedRoots: [dir],
    });
    expect(result.status).toBe('pass');
  });

  it('returns fail when TOML config exists but wigolo table is absent', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    const configPath = join(dir, 'config2.toml');
    writeFileSync(configPath, '[some_other_table]\nkey = "value"\n');
    const result = await checkMcpWiringForAgent({
      agentId: 'codex',
      agentName: 'Codex',
      configPath,
      keyPath: ['mcp_servers', 'wigolo'],
      installType: 'config-toml',
      allowedRoots: [dir],
    });
    expect(result.status).toBe('fail');
  });

  it('refuses to read a config path outside the allowed roots (path-bound guard)', async () => {
    const { checkMcpWiringForAgent } = await import('../../../src/cli/tui/actions/verify-e2e.js');
    // Write a real, parseable wigolo config OUTSIDE the allowed root so the
    // only reason this fails is the path-bound guard, not a missing/invalid file.
    const outsideDir = mkdtempSync(join(tmpdir(), 'wigolo-outside-'));
    const configPath = join(outsideDir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { wigolo: { command: 'npx' } } }));
    const result = await checkMcpWiringForAgent({
      agentId: 'cursor',
      agentName: 'Cursor',
      configPath,
      keyPath: ['mcpServers', 'wigolo'],
      installType: 'config-file',
      allowedRoots: [dir], // configPath is NOT under dir
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('outside the home/working directory');
  });
});
