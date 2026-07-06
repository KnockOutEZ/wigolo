import { describe, it, expect, vi } from 'vitest';
import { createDriveEngine } from '../../src/main/drive-engine';
import { createStudioHost, type HostTab } from '../../src/main/studio-host';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import { isCredentialContext } from 'wigolo/studio';
import type { StudioCaptureInput, StudioToolError, FieldSemantics } from 'wigolo/studio';

/**
 * P3 T2 — the studio_capture host wiring. The host computes the security-gate inputs (session id,
 * nav-epoch, FRESH credential signal) from live session state and passes them to the broker. These tests
 * drive the host against a broker that enforces the SAME gates using the REAL `isCredentialContext` + the
 * real TOCTOU comparison — so a credential-page capture is refused END-TO-END (if the host passed an
 * empty `{}` signal instead of the real one, the gate would not fire and the credential test would FAIL,
 * not pass). The FULL real handler (row-level refusal + no row) is proven in the core broker-dispatch test.
 */
const viewport = () => ({ width: 800, height: 600 });

function fakeDbg(): DebuggerLike {
  let attached = false;
  return {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    sendCommand: async (method: string) => {
      switch (method) {
        case 'Accessibility.getFullAXTree': return { nodes: [] };
        case 'DOM.getDocument': return { root: { nodeName: '#document', backendNodeId: 1, children: [] } };
        case 'Page.getLayoutMetrics': return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        default: return {};
      }
    },
    on: () => { /* no events */ },
    removeListener: () => { /* noop */ },
  };
}

/** A broker whose `capture` enforces the real gates (real isCredentialContext + TOCTOU) so a host test
 *  exercises the gate end-to-end without better-sqlite3. Overridable per-test for the resilience cases. */
function gateBroker(over: { call?: (m: string, p: unknown) => unknown } = {}) {
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (over.call) return over.call(method, params);
    if (method === 'capture') {
      const p = params as { currentNavEpoch: number; lastObserveEpoch: number; credentialSignal: { pageUrl?: string; fields?: FieldSemantics[] } };
      if (p.currentNavEpoch !== p.lastObserveEpoch) return { error_reason: 'capture_refused', hint: 'stale' } satisfies StudioToolError;
      if (isCredentialContext(p.credentialSignal)) return { error_reason: 'capture_refused', hint: 'credential' } satisfies StudioToolError;
      return { artifact_id: 7, inserted: true, content_hash: 'h' };
    }
    return { id: 1, inserted: true, contentHash: 'h' };
  });
  return { call };
}

function makeHost(broker: { call: ReturnType<typeof vi.fn> }) {
  const engine = createDriveEngine();
  let n = 0;
  const host = createStudioHost({
    broker: broker as never,
    onParked: () => { /* no card in this test */ },
    createTab: async ({ initialHolder, grant }) => {
      const tabId = `t${++n}`;
      const drive = await engine.attachTab(tabId, { debugger: fakeDbg(), viewport, grant, initialHolder });
      const state = { url: 'about:blank' };
      const tab: HostTab = {
        tabId, drive,
        browser: { navigate: async (u: string) => { state.url = u; } },
        currentUrl: () => state.url,
        readHtml: async () => '<html></html>',
      };
      return tab;
    },
    closeTab: () => { /* noop */ },
  });
  return { host };
}

const clip = (url = 'https://ex.com/page'): StudioCaptureInput => ({ type: 'clip', content: 'saved content', url });

describe('studio-host — studio_capture wiring (P3)', () => {
  it('agent capture on a non-credential page persists via the broker (after observe stamps the epoch)', async () => {
    const broker = gateBroker();
    const { host } = makeHost(broker);
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    await host.handlers.observe({}); // observe → markObserved so current === lastObserve (TOCTOU passes)
    const r = await host.handlers.capture(clip());
    expect(r).toMatchObject({ inserted: true, artifact_id: 7 });
    // the host passed live gate inputs, not agent-supplied ones
    const [, params] = broker.call.mock.calls.find(([m]) => m === 'capture')!;
    expect(params).toMatchObject({ sessionId: expect.any(String), currentNavEpoch: expect.any(Number), lastObserveEpoch: expect.any(Number) });
    expect((params as { credentialSignal: { pageUrl?: string } }).credentialSignal.pageUrl).toBe('https://ex.com/page');
  });

  it('REFUSES end-to-end on a credential page — the host passes the REAL signal, the gate fires', async () => {
    const broker = gateBroker();
    const { host } = makeHost(broker);
    await host.handlers.spawn({ startUrl: 'https://accounts.example.com/login' });
    await host.handlers.observe({});
    const r = await host.handlers.capture(clip('https://accounts.example.com/login'));
    expect(r).toMatchObject({ error_reason: 'capture_refused' });
    // proves non-tautology: the signal the host passed is non-empty (a login pageUrl), so isCredentialContext fired
    const [, params] = broker.call.mock.calls.find(([m]) => m === 'capture')!;
    expect((params as { credentialSignal: { pageUrl?: string } }).credentialSignal.pageUrl).toContain('/login');
  });

  it('no active session → no_active_session, no broker call', async () => {
    const broker = gateBroker();
    const { host } = makeHost(broker);
    const r = await host.handlers.capture(clip());
    expect(r).toMatchObject({ error_reason: 'no_active_session' });
    expect(broker.call.mock.calls.some(([m]) => m === 'capture')).toBe(false);
  });

  it('broker rejection → capture_unavailable (never throws; the client bounds a silent broker into a rejection)', async () => {
    const broker = gateBroker({ call: () => { throw new Error('studio background service timed out'); } });
    const { host } = makeHost(broker);
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    await host.handlers.observe({});
    const r = await host.handlers.capture(clip());
    expect(r).toMatchObject({ error_reason: 'capture_unavailable' });
  });
});

describe('studio-host — captureQuote (human ⌘⇧C)', () => {
  const quote = { text: 'the pricing tiers', url: 'https://ex.com/pricing', context: 'Free · Pro · Enterprise' };

  it('persists a cited clip via the broker on a non-credential page', async () => {
    const broker = gateBroker();
    const { host } = makeHost(broker);
    await host.handlers.spawn({ startUrl: 'https://ex.com/pricing' });
    await host.handlers.observe({});
    const r = await host.captureQuote('t1', quote);
    expect(r).toMatchObject({ inserted: true });
    const call = broker.call.mock.calls.find(([m]) => m === 'capture')!;
    expect((call[1] as { input: { type: string; content: string } }).input.type).toBe('clip');
    expect((call[1] as { input: { content: string } }).input.content).toContain('the pricing tiers');
  });

  it('REFUSES on a credential page (no broker capture call — quote can be a secret)', async () => {
    const broker = gateBroker();
    const { host } = makeHost(broker);
    await host.handlers.spawn({ startUrl: 'https://accounts.example.com/login' });
    await host.handlers.observe({});
    const r = await host.captureQuote('t1', { ...quote, url: 'https://accounts.example.com/login' });
    expect(r).toMatchObject({ error_reason: 'credential_context' });
    expect(broker.call.mock.calls.some(([m]) => m === 'capture')).toBe(false);
  });

  it('broker down → capture_unavailable (never throws)', async () => {
    const broker = gateBroker({ call: () => { throw new Error('timed out'); } });
    const { host } = makeHost(broker);
    await host.handlers.spawn({ startUrl: 'https://ex.com/pricing' });
    await host.handlers.observe({});
    const r = await host.captureQuote('t1', quote);
    expect(r).toMatchObject({ error_reason: 'capture_unavailable' });
  });
});
