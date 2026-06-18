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
    setStudioHost = vi.fn().mockImplementation(() => { events.push('setStudioHost'); });
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
import { getEmbedProvider } from '../../../src/providers/embed-provider.js';
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
      // Record the navigation on the SAME cdp send-log so ordering vs Fetch.enable
      // is assertable (Finding A: the interceptor must rebind before the recovery goto).
      goto: async () => { sends.push({ method: 'goto' }); return null; },
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

  it('does NOT block startup on the embedding warm — endpoint + handle come up even if warming HANGS (model load is backgrounded)', async () => {
    // Warm-before-live used to block the host on a cold model load/download (the Phase-0 model-init
    // risk). The warm is now backgrounded so the host endpoint is reachable first; a hanging warm
    // must not stall startup. (A cold model load thus warms behind a live endpoint, not in front of it.)
    vi.mocked(getEmbedProvider).mockImplementationOnce(() => new Promise(() => {})); // never resolves
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    expect(events).toContain('start'); // endpoint bound…
    expect(events).toContain('handle'); // …and handle published — startup completed despite the hanging warm
    await host.daemon.stop();
  }, 5000);

  it('still kicks off the embedding warm in the background (after the endpoint is live, not before)', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    expect(events).toContain('warmup'); // the warm is still triggered (not dropped)
    expect(events.indexOf('warmup')).toBeGreaterThan(events.indexOf('start')); // …but AFTER the endpoint is live
    await host.daemon.stop();
  });

  it('healMark on an unknown markId returns the no_such_mark error (the contract studio_marks will surface)', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    expect(await host.healMark('does-not-exist')).toEqual({ error: 'no_such_mark' });
    await host.daemon.stop();
  });

  it('wires setStudioHost BEFORE publishing the handle (closes the self-loop window in the real boot sequence)', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    expect(events).toContain('setStudioHost');
    expect(events).toContain('handle');
    // The handle is the only discovery path — setStudioHost must run first so a studio_*
    // call can't arrive, read the handle pointing at us, and proxy into a self-loop.
    expect(events.indexOf('setStudioHost')).toBeLessThan(events.indexOf('handle'));
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

  it('starts the nav interceptor on the session cdp (Fetch.enable) at boot', async () => {
    const launcher = makeCrashableHostLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: launcher.launch });
    expect(host.navInterceptor).toBeDefined();
    expect(launcher.state.cdps[0].sends.some((s) => s.method === 'Fetch.enable')).toBe(true);
    await host.navInterceptor.stop();
    await host.bridge.stop();
    await host.daemon.stop();
  });

  it('host.navigate broadcasts {t:error} on a blocked target and navigates a public one cleanly', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    const broadcastSpy = vi.spyOn(host.hub, 'broadcast');
    await host.navigate('http://169.254.169.254/'); // cloud-metadata → blocked even for the human
    expect(broadcastSpy).toHaveBeenCalledWith(host.session.id, { t: 'error', reason: 'navigation_blocked' });
    broadcastSpy.mockClear();
    await host.navigate('https://example.com/'); // public → allowed, no error
    expect(broadcastSpy).not.toHaveBeenCalled();
    await host.navInterceptor.stop();
    await host.bridge.stop();
    await host.daemon.stop();
  });

  it('holder-gates navigation (Finding C): a non-holder {t:nav} is refused, not steered', async () => {
    const launcher = makeCrashableHostLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: launcher.launch });
    const broadcastSpy = vi.spyOn(host.hub, 'broadcast');
    const cdp0 = launcher.state.cdps[0];

    // Human holds by default → the human nav steers the shared browser.
    await host.navigate('https://example.com/');
    const gotosAfterHuman = cdp0.sends.filter((s) => s.method === 'goto').length;
    expect(gotosAfterHuman).toBe(1);

    // Hand the token to the agent → a {t:nav} from the (host-stamped human) WS channel is refused.
    host.controller.handleControl({ op: 'grant', to: 'agent' });
    await host.navigate('https://example.com/elsewhere');
    expect(broadcastSpy).toHaveBeenCalledWith(host.session.id, { t: 'error', reason: 'not_control_holder' });
    expect(cdp0.sends.filter((s) => s.method === 'goto').length).toBe(gotosAfterHuman); // no new navigation

    // Human reclaims → can steer again.
    host.controller.handleControl({ op: 'reclaim' });
    await host.navigate('https://example.com/back');
    expect(cdp0.sends.filter((s) => s.method === 'goto').length).toBe(gotosAfterHuman + 1);

    await host.navInterceptor.stop();
    await host.bridge.stop();
    await host.daemon.stop();
  });

  it('reclaim aborts the agent in-flight nav (onChange→abortInFlight→Page.stopLoading); a grant does not', async () => {
    const launcher = makeCrashableHostLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: launcher.launch });
    const cdp0 = launcher.state.cdps[0];

    host.controller.handleControl({ op: 'grant', to: 'agent' }); // agent holds — a nav could be in flight
    await flush();
    expect(cdp0.sends.some((s) => s.method === 'Page.stopLoading')).toBe(false); // granting control must NOT abort

    host.controller.handleControl({ op: 'reclaim' }); // human takes over mid-flight
    await flush();
    expect(cdp0.sends.some((s) => s.method === 'Page.stopLoading')).toBe(true); // …stops the agent's in-flight nav

    await host.navInterceptor.stop();
    await host.bridge.stop();
    await host.daemon.stop();
  });

  it('studio_act navigate is gated by the REAL control token + the SAME grant the interceptor reads (single-source)', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    const reason = (r: Awaited<ReturnType<typeof host.act>>) => (r as { error_reason?: string }).error_reason;

    // Human holds by default → the agent's act is refused (gate before acting) with a resync epoch.
    const refused = await host.act({ action: 'navigate', url: 'https://example.com/' });
    expect(reason(refused)).toBe('not_holder');
    expect((refused as { currentEpoch?: number }).currentEpoch).toBe(0);

    // Hand control to the agent.
    host.controller.handleControl({ op: 'grant', to: 'agent' });
    expect(reason(await host.act({ action: 'navigate', url: 'https://example.com/' }))).toBeUndefined(); // public ok

    // localhost is blocked by default (agent default-deny) — proves the act entry guard
    // reads the agent policy off the same grant object the interceptor's provider reads.
    expect(reason(await host.act({ action: 'navigate', url: 'http://localhost:3000/' }))).toBe('navigation_blocked');

    // The human grants private-nav for this session → localhost now reachable by the agent…
    host.grantAgentPrivateNav(true);
    expect(reason(await host.act({ action: 'navigate', url: 'http://localhost:3000/' }))).toBeUndefined();

    // …but cloud-metadata stays blocked EVEN under the grant (no SSRF lane).
    expect(reason(await host.act({ action: 'navigate', url: 'http://169.254.169.254/' }))).toBe('navigation_blocked');

    await host.navInterceptor.stop();
    await host.bridge.stop();
    await host.daemon.stop();
  });

  it('exposes a human-only, per-session, revocable agent private-nav grant (default-deny)', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    // The grant is a host-side method reachable by the human/UI only — the agent has
    // no path to it (it drives via studio_act, not the host API). Default-deny; flip + revoke.
    expect(typeof host.grantAgentPrivateNav).toBe('function');
    expect(() => host.grantAgentPrivateNav(true)).not.toThrow();
    expect(() => host.grantAgentPrivateNav(false)).not.toThrow();
    await host.navInterceptor.stop();
    await host.bridge.stop();
    await host.daemon.stop();
  });

  it('rebinds the nav interceptor BEFORE the recovery goto on the fresh cdp (Finding A)', async () => {
    const launcher = makeCrashableHostLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: launcher.launch });
    await host.navigate('https://example.com/'); // sets currentUrl so the recovery re-nav fires

    await launcher.fireCrash();
    await flush();

    expect(launcher.state.cdps.length).toBe(2); // relaunched
    const fresh = launcher.state.cdps[1].sends.map((s) => s.method);
    const enableIdx = fresh.indexOf('Fetch.enable');
    const gotoIdx = fresh.indexOf('goto');
    expect(enableIdx).toBeGreaterThanOrEqual(0); // interceptor rebound on the fresh cdp
    expect(gotoIdx).toBeGreaterThanOrEqual(0); // recovery re-nav happened on the fresh cdp
    expect(enableIdx).toBeLessThan(gotoIdx); // …and the guard was live BEFORE the navigation

    await host.navInterceptor.stop();
    await host.bridge.stop();
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
    expect(launcher.state.cdps[1].sends.some((s) => s.method === 'Fetch.enable')).toBe(true); // nav interceptor rebound on the fresh cdp

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
