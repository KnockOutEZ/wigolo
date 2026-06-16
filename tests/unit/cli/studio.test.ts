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

// A launcher whose page can be crashed and which hands out a fresh, send-recording
// cdp per (re)launch — so the HOST wiring (onRecovered→bridge.restart(fresh cdp),
// onFailed→session_failed) is testable at the startStudioHost boundary.
function makeCrashableHostLauncher() {
  const state = {
    cdps: [] as Array<{ sends: Array<{ method: string }> }>,
    crashCb: null as null | (() => void | Promise<void>),
  };
  const launch = async (): Promise<LaunchedSessionBrowser> => {
    const sends: Array<{ method: string }> = [];
    const cdp = { sends, send: async (method: string) => { sends.push({ method }); return {}; }, on: () => {}, off: () => {} };
    const page = {
      close: async () => {},
      goto: async () => null,
      on: (e: string, cb: () => void) => { if (e === 'crash') state.crashCb = cb; },
    };
    const browser = { close: async () => {}, on: () => {} };
    const context = { close: async () => {} };
    state.cdps.push(cdp);
    return { browser, context, page, cdp } as unknown as LaunchedSessionBrowser;
  };
  return { launch, state, fireCrash: async () => { if (state.crashCb) await state.crashCb(); } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

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

  it('wires crash recovery: rebinds the screencast to the fresh cdp, and notifies clients on exhaustion', async () => {
    process.env.WIGOLO_STUDIO_BROWSER_CRASH_MAX_RESTARTS = '1';
    resetConfig();
    const launcher = makeCrashableHostLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: launcher.launch });
    delete process.env.WIGOLO_STUDIO_BROWSER_CRASH_MAX_RESTARTS; // already baked into the SessionBrowser
    const broadcastSpy = vi.spyOn(host.hub, 'broadcast');

    // crash 1 → recover → bridge.restart(fresh cdp): the NEW session gets a startScreencast
    await launcher.fireCrash();
    await flush();
    expect(launcher.state.cdps.length).toBe(2); // relaunched
    expect(launcher.state.cdps[1].sends.some((s) => s.method === 'Page.startScreencast')).toBe(true);

    // ...and the INPUT forwarder rebound too: post-recovery human input dispatches to the FRESH cdp, not the dead one.
    await host.controller.handleWireInput({ kind: 'mouse', epoch: 0, type: 'mouseMoved', nx: 0.5, ny: 0.5 });
    expect(launcher.state.cdps[1].sends.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(launcher.state.cdps[0].sends.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(false);

    // crash 2 → exceeds maxRestarts(1) → onFailed → clients told the session died (not silent)
    await launcher.fireCrash();
    await flush();
    expect(broadcastSpy).toHaveBeenCalledWith(host.session.id, { t: 'error', reason: 'session_failed' });

    await host.bridge.stop();
    await host.daemon.stop();
  });
});
