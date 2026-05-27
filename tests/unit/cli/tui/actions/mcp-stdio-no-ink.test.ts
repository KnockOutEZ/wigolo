/**
 * Asserts that the MCP stdio path (runMcp) does NOT mount the Ink TUI.
 *
 * The invariant: only init/config/dashboard/doctor --interactive mount Ink.
 * MCP mode starts the protocol server on stdio; rendering Ink would corrupt
 * the JSON-RPC framing.
 *
 * This test EXERCISES THE ACTUAL MCP DISPATCH (runMcp from src/cli/mcp.ts —
 * the body of the `case 'mcp'` branch in src/index.ts). It asserts startServer
 * is called and that the Ink entry points (runInkInit / runInkConfig) are NOT.
 * It would fail if someone added an Ink mount to the mcp path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const startServerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runInkInitMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runInkConfigMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const tryConnectDaemonMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

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
  tryConnectDaemon: tryConnectDaemonMock,
}));

import { runMcp } from '../../../../../src/cli/mcp.js';
import { parseCommand } from '../../../../../src/cli/index.js';

beforeEach(() => {
  startServerMock.mockClear();
  runInkInitMock.mockClear();
  runInkConfigMock.mockClear();
  tryConnectDaemonMock.mockClear().mockResolvedValue(null);
});

describe('runMcp — MCP stdio path', () => {
  it('calls startServer (begins the protocol server)', async () => {
    await runMcp();
    expect(startServerMock).toHaveBeenCalledOnce();
  });

  it('NEVER mounts Ink (runInkInit not called)', async () => {
    await runMcp();
    expect(runInkInitMock).not.toHaveBeenCalled();
  });

  it('NEVER mounts the config router (runInkConfig not called)', async () => {
    await runMcp();
    expect(runInkConfigMock).not.toHaveBeenCalled();
  });

  it('starts the local server even when a daemon is detected', async () => {
    tryConnectDaemonMock.mockResolvedValueOnce({ status: 'healthy' });
    await runMcp();
    expect(startServerMock).toHaveBeenCalledOnce();
    expect(runInkInitMock).not.toHaveBeenCalled();
    expect(runInkConfigMock).not.toHaveBeenCalled();
  });

  it('starts the local server even when daemon proxy throws', async () => {
    tryConnectDaemonMock.mockRejectedValueOnce(new Error('proxy unavailable'));
    await runMcp();
    expect(startServerMock).toHaveBeenCalledOnce();
    expect(runInkInitMock).not.toHaveBeenCalled();
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
