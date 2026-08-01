/**
 * Asserts that the MCP stdio path (runMcp) does NOT mount the Ink TUI.
 *
 * The invariant: only init/config/dashboard/doctor --interactive mount Ink.
 * MCP mode starts the protocol server on stdio; rendering Ink would corrupt
 * the JSON-RPC framing.
 *
 * This test EXERCISES THE ACTUAL MCP DISPATCH (runMcp from src/cli/mcp.ts —
 * the body of the `case 'mcp'` branch in src/index.ts). It asserts the lazy
 * stdio server starts and that the unified entry router (`runEntry`) is NOT. It would
 * fail if someone added an Ink mount to the mcp path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const startStdioServerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runEntryMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    resolution: { mode: 'home', firstRun: false, headless: false },
    mounted: false,
  }),
);
vi.mock('../../../../../src/server/control.js', () => ({
  startStdioServer: startStdioServerMock,
}));

vi.mock('../../../../../src/cli/tui/entry.js', () => ({
  runEntry: runEntryMock,
  resolveEntry: vi.fn(),
}));

import { runMcp } from '../../../../../src/cli/mcp.js';
import { parseCommand } from '../../../../../src/cli/index.js';

beforeEach(() => {
  startStdioServerMock.mockClear();
  runEntryMock.mockClear();
});

describe('runMcp — MCP stdio path', () => {
  it('calls the lazy stdio control plane', async () => {
    await runMcp();
    expect(startStdioServerMock).toHaveBeenCalledOnce();
  });

  it('NEVER mounts Ink (runEntry not called)', async () => {
    await runMcp();
    expect(runEntryMock).not.toHaveBeenCalled();
  });

});

describe('parseCommand routing — mcp vs Ink commands', () => {
  it('no args routes to mcp (stdio), not init or config', () => {
    expect(parseCommand([]).command).toBe('mcp');
  });

  it('init command routes to init (an Ink-capable command)', () => {
    expect(parseCommand(['init']).command).toBe('init');
  });

  it('config command routes to config, not mcp', () => {
    const { command } = parseCommand(['config']);
    expect(command).toBe('config');
    expect(command).not.toBe('mcp');
  });
});
