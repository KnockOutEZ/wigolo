import { describe, it, expect } from 'vitest';
import { NavInterceptor, navigateSession } from '../../../src/studio/nav.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeFakeCdp() {
  const sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      sends.push({ method, params: params ?? {} });
      return {};
    },
    on: (e: string, cb: (p: never) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(cb as (p: unknown) => void);
    },
    off: (e: string, cb: (p: never) => void) => listeners.get(e)?.delete(cb as (p: unknown) => void),
  };
  const pause = (requestId: string, url: string) =>
    [...(listeners.get('Fetch.requestPaused') ?? [])].forEach((cb) =>
      cb({ requestId, request: { url }, resourceType: 'Document' } as never),
    );
  return { cdp, sends, pause, listenerCount: () => listeners.get('Fetch.requestPaused')?.size ?? 0 };
}

describe('NavInterceptor', () => {
  it('start() enables Fetch scoped to Document navigations at the Request stage (not all resources)', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor({ source: 'human', allowPrivate: true });
    await iv.start(f.cdp);
    const enable = f.sends.find((s) => s.method === 'Fetch.enable');
    expect(enable?.params).toEqual({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    expect(f.listenerCount()).toBe(1);
  });

  it('continues a public navigation request', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor({ source: 'human', allowPrivate: true });
    await iv.start(f.cdp);
    f.pause('r1', 'https://example.com/');
    await tick();
    expect(f.sends.some((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === 'r1')).toBe(true);
    expect(f.sends.some((s) => s.method === 'Fetch.failRequest')).toBe(false);
  });

  it('fails a navigation to cloud-metadata regardless of policy', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor({ source: 'human', allowPrivate: true });
    await iv.start(f.cdp);
    f.pause('r2', 'http://169.254.169.254/latest/meta-data/');
    await tick();
    expect(f.sends.some((s) => s.method === 'Fetch.failRequest' && s.params.requestId === 'r2')).toBe(true);
  });

  it('is source-aware PER HOP: localhost continues for the human, fails for the agent', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor({ source: 'human', allowPrivate: true });
    await iv.start(f.cdp);
    f.pause('h', 'http://localhost:3000/');
    await tick();
    expect(f.sends.some((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === 'h')).toBe(true);

    iv.setPolicy({ source: 'agent', allowPrivate: false });
    f.pause('a', 'http://localhost:3000/');
    await tick();
    expect(f.sends.some((s) => s.method === 'Fetch.failRequest' && s.params.requestId === 'a')).toBe(true);
  });

  it('FAILS CLOSED: if continuing the request throws, the request is failed (blocked), never left open', async () => {
    const f = makeFakeCdp();
    const orig = f.cdp.send;
    f.cdp.send = async (m: string, p?: Record<string, unknown>) => {
      if (m === 'Fetch.continueRequest') throw new Error('boom');
      return orig(m, p);
    };
    const iv = new NavInterceptor({ source: 'human', allowPrivate: true });
    await iv.start(f.cdp);
    f.pause('x', 'https://example.com/'); // would normally continue
    await tick();
    expect(f.sends.some((s) => s.method === 'Fetch.failRequest' && s.params.requestId === 'x')).toBe(true);
  });

  it('rebind() moves interception to a fresh cdp and stops listening on the dead one (crash recovery)', async () => {
    const dead = makeFakeCdp();
    const fresh = makeFakeCdp();
    const iv = new NavInterceptor({ source: 'human', allowPrivate: true });
    await iv.start(dead.cdp);
    await iv.rebind(fresh.cdp);
    expect(dead.listenerCount()).toBe(0);
    expect(fresh.sends.some((s) => s.method === 'Fetch.enable')).toBe(true);
    fresh.pause('fr', 'https://example.com/');
    await tick();
    expect(fresh.sends.some((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === 'fr')).toBe(true);
  });
});

describe('navigateSession', () => {
  function makeFakeBrowser() {
    const gotos: string[] = [];
    return { browser: { navigate: async (url: string) => { gotos.push(url); } }, gotos };
  }

  it('navigates when the initial URL passes the policy', async () => {
    const b = makeFakeBrowser();
    const r = await navigateSession(b.browser, 'https://example.com/', { source: 'human' });
    expect(r.ok).toBe(true);
    expect(b.gotos).toEqual(['https://example.com/']);
  });

  it('rejects a blocked initial URL WITHOUT navigating', async () => {
    const b = makeFakeBrowser();
    const r = await navigateSession(b.browser, 'http://169.254.169.254/', { source: 'human' });
    expect(r.ok).toBe(false);
    expect(b.gotos).toEqual([]);
  });

  it('lets the human reach localhost but blocks the agent (policy passthrough)', async () => {
    const b = makeFakeBrowser();
    expect((await navigateSession(b.browser, 'http://localhost:3000/', { source: 'human' })).ok).toBe(true);
    expect((await navigateSession(b.browser, 'http://localhost:3000/', { source: 'agent' })).ok).toBe(false);
  });

  it('returns ok:false (does not throw) when navigation fails — e.g. a redirect hop was blocked', async () => {
    const browser = { navigate: async () => { throw new Error('net::ERR_FAILED'); } };
    const r = await navigateSession(browser, 'https://example.com/', { source: 'human' });
    expect(r.ok).toBe(false);
  });
});
