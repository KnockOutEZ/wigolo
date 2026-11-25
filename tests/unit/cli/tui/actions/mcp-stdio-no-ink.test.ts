/**
 * Asserts that the MCP stdio path (runMcp) does NOT mount the Ink TUI.
 *
 * The invariant: only init/config/dashboard/doctor --interactive mount Ink.
 * MCP mode starts the protocol server on stdio; rendering Ink would corrupt
 * the JSON-RPC framing.
 *
 * This test EXERCISES THE ACTUAL MCP DISPATCH (runMcp from src/cli/mcp.ts —
 * the body of the `case 'mcp'` branch in src/index.ts). It asserts startServer
 * is called and that the unified entry router (`runEntry`) is NOT. It would
 * fail if someone added an Ink mount to the mcp path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const startServerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runEntryMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    resolution: { mode: 'home', firstRun: false, headless: false },
    mounted: false,
  }),
);
const tryConnectDaemonMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('../../../../../src/server.js', () => ({
  startServer: startServerMock,
}));

vi.mock('../../../../../src/cli/tui/entry.js', () => ({
  runEntry: runEntryMock,
  resolveEntry: vi.fn(),
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
  runEntryMock.mockClear();
  tryConnectDaemonMock.mockClear().mockResolvedValue(null);
});

describe('runMcp — MCP stdio path', () => {
  it('calls startServer (begins the protocol server)', async () => {
    await runMcp();
    expect(startServerMock).toHaveBeenCalledOnce();
  });

  it('NEVER mounts Ink (runEntry not called)', async () => {
    await runMcp();
    expect(runEntryMock).not.toHaveBeenCalled();
  });

  it('starts the local server even when a daemon is detected', async () => {
    tryConnectDaemonMock.mockResolvedValueOnce({ status: 'healthy' });
    await runMcp();
    expect(startServerMock).toHaveBeenCalledOnce();
    expect(runEntryMock).not.toHaveBeenCalled();
  });

  it('starts the local server even when daemon proxy throws', async () => {
    tryConnectDaemonMock.mockRejectedValueOnce(new Error('proxy unavailable'));
    await runMcp();
    expect(startServerMock).toHaveBeenCalledOnce();
    expect(runEntryMock).not.toHaveBeenCalled();
  });

  it('writes no license notice to stderr (that line belongs to `wigolo serve` on a network bind only)', async () => {
    let stderrOutput = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
    try {
      await runMcp();
    } finally {
      spy.mockRestore();
    }
    expect(stderrOutput).not.toMatch(/AGPL|LICENSING\.md/);
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
