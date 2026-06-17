import { describe, it, expect } from 'vitest';
import { NavInterceptor, navigateSession, type NavPolicy } from '../../../src/studio/nav.js';
import { policyForHolder, type NavGrant } from '../../../src/studio/nav-policy.js';
import type { ControlParty } from '../../../src/studio/control-token.js';

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

const fixed = (p: NavPolicy) => () => p;
const continued = (f: ReturnType<typeof makeFakeCdp>, id: string) =>
  f.sends.some((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === id);
const failed = (f: ReturnType<typeof makeFakeCdp>, id: string) =>
  f.sends.some((s) => s.method === 'Fetch.failRequest' && s.params.requestId === id);

describe('NavInterceptor', () => {
  it('start() enables Fetch scoped to Document navigations at the Request stage (not all resources)', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor(fixed({ source: 'human', allowPrivate: true }));
    await iv.start(f.cdp);
    const enable = f.sends.find((s) => s.method === 'Fetch.enable');
    expect(enable?.params).toEqual({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    expect(f.listenerCount()).toBe(1);
  });

  it('continues a public navigation request', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor(fixed({ source: 'human', allowPrivate: true }));
    await iv.start(f.cdp);
    f.pause('r1', 'https://example.com/');
    await tick();
    expect(continued(f, 'r1')).toBe(true);
    expect(f.sends.some((s) => s.method === 'Fetch.failRequest')).toBe(false);
  });

  it('fails a navigation to cloud-metadata regardless of policy', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor(fixed({ source: 'human', allowPrivate: true }));
    await iv.start(f.cdp);
    f.pause('r2', 'http://169.254.169.254/latest/meta-data/');
    await tick();
    expect(failed(f, 'r2')).toBe(true);
  });

  it('PULL-AT-EVAL: each hop is judged under the policy the provider returns AT EVALUATION TIME, not at start()', async () => {
    // The interceptor pulls the live policy per hop. A flip to the agent takes effect
    // on the very next hop — there is no disarm→re-arm window where a stale, more
    // permissive policy could leak a hop through (the dangerous direction).
    const f = makeFakeCdp();
    let holder: ControlParty = 'human';
    const grant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: false };
    const iv = new NavInterceptor(() => policyForHolder(holder, grant));
    await iv.start(f.cdp);

    f.pause('h', 'http://localhost:3000/'); // human holds → localhost allowed
    await tick();
    expect(continued(f, 'h')).toBe(true);

    holder = 'agent'; // token flips to the agent
    f.pause('a', 'http://localhost:3000/'); // an immediate agent nav to localhost…
    await tick();
    expect(failed(f, 'a')).toBe(true); // …is judged under AGENT policy (blocked), never the stale human policy
    expect(continued(f, 'a')).toBe(false);
  });

  it('PULL-AT-EVAL: a token flip MID-REDIRECT-CHAIN re-validates the remaining hops under the new holder', async () => {
    // SSRF-via-redirect is the classic bypass; the per-hop guard is the catch. A flip
    // mid-chain must re-judge the remaining hops under the live holder.
    const f = makeFakeCdp();
    let holder: ControlParty = 'human';
    const grant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: false };
    const iv = new NavInterceptor(() => policyForHolder(holder, grant));
    await iv.start(f.cdp);

    f.pause('hop1', 'https://benign.example/'); // public, human → continues
    await tick();
    expect(continued(f, 'hop1')).toBe(true);

    holder = 'agent'; // grant flips mid-chain
    f.pause('hop2', 'http://10.0.0.5/'); // redirect toward RFC1918…
    f.pause('hop3', 'http://169.254.169.254/'); // …and cloud-metadata
    await tick();
    expect(failed(f, 'hop2')).toBe(true); // re-validated under the agent policy → blocked
    expect(failed(f, 'hop3')).toBe(true); // metadata blocked for either party
  });

  it('PULL-AT-EVAL reads the live grant: agent localhost is blocked by default, allowed after a grant, metadata still blocked', async () => {
    const f = makeFakeCdp();
    const grant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: false };
    const iv = new NavInterceptor(() => policyForHolder('agent', grant));
    await iv.start(f.cdp);

    f.pause('d', 'http://localhost:3000/'); // default-deny
    await tick();
    expect(failed(f, 'd')).toBe(true);

    grant.agentAllowPrivate = true; // human issues the per-session grant
    f.pause('g', 'http://localhost:3000/');
    await tick();
    expect(continued(f, 'g')).toBe(true); // grant lifts localhost…

    f.pause('m', 'http://169.254.169.254/'); // …but NOT cloud-metadata
    await tick();
    expect(failed(f, 'm')).toBe(true);
  });

  it('abortInFlight() stops the in-flight load (Page.stopLoading) and fails a still-in-flight hop closed', async () => {
    // The nav analog of the in-flight-click abort: a human reclaim mid-navigation must
    // stop the agent's nav, not let it complete under a revoked grant. Page.stopLoading
    // cancels the load (a half-loaded page is fine); a hop caught mid-flight is failed.
    const f = makeFakeCdp();
    let release!: () => void;
    const orig = f.cdp.send;
    f.cdp.send = async (m: string, p?: Record<string, unknown>) => {
      if (m === 'Fetch.continueRequest') await new Promise<void>((r) => { release = r; }); // hold the hop in-flight
      return orig(m, p);
    };
    const iv = new NavInterceptor(fixed({ source: 'agent', allowPrivate: true }));
    await iv.start(f.cdp);
    f.pause('inflight', 'https://example.com/'); // allowed → continue is awaited (hangs) → still in-flight
    await tick();

    await iv.abortInFlight();
    expect(f.sends.some((s) => s.method === 'Page.stopLoading')).toBe(true);
    expect(failed(f, 'inflight')).toBe(true);

    release(); // let the held continue resolve — must not throw
    await tick();
  });

  it('abortInFlight() is a safe no-op when nothing is in flight / not started', async () => {
    const f = makeFakeCdp();
    const iv = new NavInterceptor(fixed({ source: 'human', allowPrivate: true }));
    await iv.abortInFlight(); // not started yet
    expect(f.sends.length).toBe(0);
    await iv.start(f.cdp);
    await iv.abortInFlight(); // started, nothing loading → just stopLoading, no throw
    expect(f.sends.some((s) => s.method === 'Page.stopLoading')).toBe(true);
  });

  it('FAILS CLOSED: if continuing the request throws, the request is failed (blocked), never left open', async () => {
    const f = makeFakeCdp();
    const orig = f.cdp.send;
    f.cdp.send = async (m: string, p?: Record<string, unknown>) => {
      if (m === 'Fetch.continueRequest') throw new Error('boom');
      return orig(m, p);
    };
    const iv = new NavInterceptor(fixed({ source: 'human', allowPrivate: true }));
    await iv.start(f.cdp);
    f.pause('x', 'https://example.com/'); // would normally continue
    await tick();
    expect(failed(f, 'x')).toBe(true);
  });

  it('start() fails CLOSED if Fetch.enable rejects: detaches the listener and rethrows (no half-armed interceptor)', async () => {
    // A half-armed interceptor (listener attached but Fetch domain NOT enabled →
    // Chromium emits no requestPaused events) would silently pass navigations
    // unguarded. start() must leave a clean unbound state and propagate the error
    // so the caller (e.g. crash recovery) can fail closed.
    const f = makeFakeCdp();
    const orig = f.cdp.send;
    f.cdp.send = async (m: string, p?: Record<string, unknown>) => {
      if (m === 'Fetch.enable') throw new Error('cdp gone');
      return orig(m, p);
    };
    const iv = new NavInterceptor(fixed({ source: 'agent', allowPrivate: false }));
    await expect(iv.start(f.cdp)).rejects.toThrow('cdp gone');
    expect(f.listenerCount()).toBe(0); // detached — not silently half-armed
  });

  it('rebind() moves interception to a fresh cdp and stops listening on the dead one (crash recovery)', async () => {
    const dead = makeFakeCdp();
    const fresh = makeFakeCdp();
    const iv = new NavInterceptor(fixed({ source: 'human', allowPrivate: true }));
    await iv.start(dead.cdp);
    await iv.rebind(fresh.cdp);
    expect(dead.listenerCount()).toBe(0);
    expect(fresh.sends.some((s) => s.method === 'Fetch.enable')).toBe(true);
    fresh.pause('fr', 'https://example.com/');
    await tick();
    expect(continued(fresh, 'fr')).toBe(true);
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
