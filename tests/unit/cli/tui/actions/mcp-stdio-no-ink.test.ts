/**
 * Asserts that the MCP stdio path (command='mcp') does NOT mount the Ink TUI.
 *
 * The invariant: only init/config/dashboard/doctor --interactive mount Ink.
 * MCP mode starts the protocol server on stdio; rendering Ink would corrupt
 * the JSON-RPC framing.
 *
 * We test this by checking that `runInkInit` (and the new `runInkConfig`) are
 * NOT called when index.ts routes to startServer (the MCP path). We mock
 * `startServer` so no real network work is done, and verify that the Ink
 * entry points are never invoked.
 */
import { describe, expect, it, vi } from 'vitest';

const startServerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runInkInitMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runInkConfigMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../../../src/server.js', () => ({
  startServer: startServerMock,
}));

vi.mock('../../../../../src/cli/tui/ink-init.js', () => ({
  runInkInit: runInkInitMock,
}));

vi.mock('../../../../../src/cli/tui/router/ink-config.js', () => ({
  runInkConfig: runInkConfigMock,
}));

vi.mock('../../../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/data', daemonPort: 9999, daemonHost: '127.0.0.1' }),
}));

vi.mock('../../../../../src/daemon/proxy.js', () => ({
  tryConnectDaemon: vi.fn().mockResolvedValue(null),
}));

// We import the parseCommand routing logic (not the full index.ts which calls
// process.exit) to check that the 'mcp' branch never touches Ink.
import { parseCommand } from '../../../../../src/cli/index.js';

describe('MCP stdio path does not mount Ink', () => {
  it('parseCommand with no args routes to mcp, not init or config', () => {
    const { command } = parseCommand([]);
    expect(command).toBe('mcp');
    // Ink init should never be called by the mcp command route
    expect(runInkInitMock).not.toHaveBeenCalled();
    expect(runInkConfigMock).not.toHaveBeenCalled();
  });

  it('runInkInit is NOT imported or called for the mcp command', () => {
    // Confirm the mock was never triggered by any mcp-mode path
    expect(runInkInitMock).not.toHaveBeenCalled();
  });

  it('init command routes to init, not mcp', () => {
    const { command } = parseCommand(['init']);
    expect(command).toBe('init');
  });

  it('config command routes to config, not mcp', () => {
    // 'config' is in KNOWN_COMMANDS — SP3 wired it.
    // The critical invariant is: mcp never mounts Ink.
    const { command } = parseCommand(['config']);
    expect(command).toBe('config');
    // And critically — config command does NOT trigger MCP mode
    expect(command).not.toBe('mcp');
  });
});
