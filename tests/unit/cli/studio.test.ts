import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

const events: string[] = [];

vi.mock('../../../src/daemon/http-server.js', () => ({
  DaemonHttpServer: class {
    constructor(
      public options: {
        port: number;
        host: string;
        auth?: { token: string; host: string };
        requestTimeoutMs?: number;
        onUpgrade?: unknown;
      },
    ) {}
    start = vi.fn().mockImplementation(async () => {
      events.push('start');
      return 'http://127.0.0.1:7777';
    });
    stop = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../../src/providers/embed-provider.js', () => ({
  // getEmbedProvider warms the model internally before resolving — model that here.
  getEmbedProvider: vi.fn().mockImplementation(async () => {
    events.push('warmup');
    return { embed: vi.fn(), dim: 384, modelId: 'BGE-small-en-v1.5' };
  }),
}));

vi.mock('../../../src/studio/handle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/handle.js')>();
  return { ...actual, writeHandle: vi.fn(() => { events.push('handle'); }) };
});

import { parseStudioArgs, startStudioHost } from '../../../src/cli/studio.js';
import { writeHandle } from '../../../src/studio/handle.js';
import type { LaunchedSessionBrowser } from '../../../src/studio/session-browser.js';

// A fake session-browser launcher: no real Chromium, so the host boots in unit tests.
const fakeBrowserLauncher = async (): Promise<LaunchedSessionBrowser> =>
  ({
    browser: { close: async () => {}, on: () => {} },
    context: { close: async () => {} },
    page: { close: async () => {}, goto: async () => null, on: () => {} },
    cdp: { send: async () => ({}), on: () => {}, off: () => {} },
  }) as unknown as LaunchedSessionBrowser;

describe('cli/studio parseStudioArgs', () => {
  beforeEach(() => resetConfig());
  afterEach(() => resetConfig());

  it('defaults host to loopback and allowRemote to false', () => {
    const p = parseStudioArgs([]);
    expect(p.host).toBe('127.0.0.1');
    expect(p.allowRemote).toBe(false);
  });

  it('parses --port, --host, and --allow-remote', () => {
    const p = parseStudioArgs(['--port', '7777', '--host', '0.0.0.0', '--allow-remote']);
    expect(p.port).toBe(7777);
    expect(p.host).toBe('0.0.0.0');
    expect(p.allowRemote).toBe(true);
  });
});

describe('cli/studio startStudioHost', () => {
  beforeEach(() => {
    events.length = 0;
    resetConfig();
  });
  afterEach(() => resetConfig());

  it('warms the embedding model BEFORE the session goes live (handle written)', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    expect(events).toContain('warmup');
    // Warmup must complete before the host listens and before the handle is published.
    expect(events.indexOf('warmup')).toBeLessThan(events.indexOf('start'));
    expect(events.indexOf('warmup')).toBeLessThan(events.indexOf('handle'));
    await host.daemon.stop();
  });

  it('writes a handle carrying the session id, endpoint, and token', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    expect(writeHandle).toHaveBeenCalled();
    const written = vi.mocked(writeHandle).mock.lastCall?.[0];
    expect(written?.endpoint).toBe('http://127.0.0.1:7777');
    expect(written?.token).toBeTruthy();
    expect(written?.id).toBe(host.session.id);
    expect(host.daemon.options.auth?.token).toBe(written?.token); // host enforces the same token
    await host.daemon.stop();
  });

  it('refuses a non-loopback bind without --allow-remote', async () => {
    await expect(
      startStudioHost({ port: 0, host: '0.0.0.0', allowRemote: false, browserLauncher: fakeBrowserLauncher }),
    ).rejects.toThrow(/allow-remote/i);
  });

  it('wires the websocket hub (onUpgrade) into the daemon and starts the session browser', async () => {
    const host = await startStudioHost({
      port: 0,
      host: '127.0.0.1',
      allowRemote: false,
      browserLauncher: fakeBrowserLauncher,
    });
    expect(typeof host.daemon.options.onUpgrade).toBe('function'); // hub wired to the upgrade seam
    expect(host.hub).toBeDefined();
    expect(host.hub.clientCount(host.session.id)).toBe(0);
    expect(host.sessionBrowser.running).toBe(true); // session browser live before the handle is published
    expect(host.bridge).toBeDefined(); // screencast bridge constructed + started
    await host.bridge.stop();
    await host.sessionBrowser.close();
    await host.daemon.stop();
  });
});
