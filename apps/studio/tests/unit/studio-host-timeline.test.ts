import { describe, it, expect, vi } from 'vitest';
import { createDriveEngine } from '../../src/main/drive-engine';
import { createStudioHost, type HostTab } from '../../src/main/studio-host';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import type { AuditRecordInput } from 'wigolo/studio';
import { makeFakeBroker } from '../helpers/fake-broker';

/**
 * P6 F4.3 — the per-session audit log → broker persist + live timeline broadcast wiring. A driven agent
 * act (act.ts records it into the in-memory SessionAuditLog) must (a) call broker `persistAudit` and (b)
 * fan a page-text-free `{t:'audit'}` broadcast to the renderer. A credential-context step stores
 * `target.url` ORIGIN-ONLY (M3) — no path, no query-string secret — and links no screenshot.
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

function makeHost(broadcasts: Record<string, unknown>[]) {
  const broker = makeFakeBroker();
  const engine = createDriveEngine();
  let n = 0;
  const host = createStudioHost({
    broker: broker as never,
    onParked: () => { /* no card in this test */ },
    createTab: async ({ initialHolder, grant }) => {
      const tabId = `t${++n}`;
      const drive = await engine.attachTab(tabId, {
        debugger: fakeDbg(), viewport, grant, initialHolder,
        broadcast: (m) => broadcasts.push(m),
      });
      const state = { url: 'about:blank' };
      const tab: HostTab = {
        tabId, drive,
        browser: { navigate: async (u: string) => { state.url = u; } },
        currentUrl: () => state.url,
        readHtml: async () => '<html></html>',
        storageState: async () => ({ cookies: [], origins: [] }),
        applyStorageState: async () => {},
      };
      return tab;
    },
    closeTab: () => { /* noop */ },
  });
  return { host, broker };
}

const persistedEntries = (broker: { call: ReturnType<typeof vi.fn> }): AuditRecordInput[] =>
  broker.call.mock.calls.filter(([m]) => m === 'persistAudit').map(([, p]) => (p as { entry: AuditRecordInput }).entry);

describe('studio-host — P6 F4 audit → broker persist + live broadcast', () => {
  it('a driven act records to the broker (persistAudit) AND fans a page-text-free {t:audit} broadcast', async () => {
    const broadcasts: Record<string, unknown>[] = [];
    const { host, broker } = makeHost(broadcasts);
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    await host.handlers.act({ action: 'scroll', direction: 'down', amount: 100 });

    const audit = broadcasts.filter((b) => b.t === 'audit');
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]).toMatchObject({ action: 'scroll', direction: 'down', amount: 100, seq: expect.any(Number) });

    await vi.waitFor(() => expect(persistedEntries(broker).length).toBeGreaterThanOrEqual(1));
    expect(persistedEntries(broker).some((e) => e.action === 'scroll')).toBe(true);
  });

  it('a credential-context step stores target.url ORIGIN-ONLY (no path, no query secret) — M3', async () => {
    const broadcasts: Record<string, unknown>[] = [];
    const { host, broker } = makeHost(broadcasts);
    await host.handlers.spawn({ startUrl: 'https://accounts.example.com/login' });
    // currentUrl is now the login page → isCredentialPage() is true; the navigate url carries a token.
    await host.handlers.act({ action: 'navigate', url: 'https://accounts.example.com/login?token=SECRET' });

    await vi.waitFor(() => expect(persistedEntries(broker).some((e) => e.action === 'navigate')).toBe(true));
    const nav = persistedEntries(broker).find((e) => e.action === 'navigate')!;
    expect(nav.target?.url).toBe('https://accounts.example.com');
    expect(nav.target?.url).not.toContain('SECRET');
    expect(nav.target?.url).not.toContain('/login');

    // the live broadcast is likewise origin-only (never the token) — no raw page text on the wire
    const navWire = broadcasts.find((b) => b.t === 'audit' && b.action === 'navigate') as { url?: string } | undefined;
    expect(navWire?.url).toBe('https://accounts.example.com');
  });

  it('a non-credential navigate keeps the full url in the persisted row (forensic value)', async () => {
    const broadcasts: Record<string, unknown>[] = [];
    const { host, broker } = makeHost(broadcasts);
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    await host.handlers.act({ action: 'navigate', url: 'https://ex.com/deep/path?q=1' });

    await vi.waitFor(() => expect(persistedEntries(broker).some((e) => e.action === 'navigate')).toBe(true));
    const nav = persistedEntries(broker).find((e) => e.action === 'navigate')!;
    expect(nav.target?.url).toBe('https://ex.com/deep/path?q=1');
  });
});
