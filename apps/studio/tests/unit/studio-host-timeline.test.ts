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

function makeHost(broadcasts: Record<string, unknown>[], brokerOver: Record<string, (p: unknown) => unknown> = {}) {
  const broker = makeFakeBroker(brokerOver);
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

  it('listAudit maps broker rows to renderer AuditDto — origin-only url + host-derived outcome (F4.5)', async () => {
    const rows = [
      { seq: 2, action: 'navigate', epoch: 1, target: { url: 'https://ex.com/a?tok=SECRET' }, outcome: { ok: true }, ts: 2000 },
      { seq: 1, action: 'click', epoch: 1, target: { ref: 'e1' }, outcome: { ok: false, error_reason: 'not_holder' }, ts: 1000 },
    ];
    const { host } = makeHost([], { listAudit: () => rows });
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    const out = await host.listAudit();
    const nav = out.find((e) => e.seq === 2)!;
    expect(nav).toMatchObject({ action: 'navigate', url: 'https://ex.com', ok: true });
    expect(nav.url).not.toContain('SECRET');
    expect(out.find((e) => e.seq === 1)).toMatchObject({ action: 'click', ref: 'e1', ok: false, error_reason: 'not_holder' });
  });

  it('listAudit degrades to [] when the broker is down (never errors the UI)', async () => {
    const { host } = makeHost([], { listAudit: () => { throw new Error('broker down'); } });
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    expect(await host.listAudit()).toEqual([]);
  });

  it('synthesizeSession routes to the broker for the active session + returns its DTO (F3)', async () => {
    const dto = { brief: { topics: ['t'], highlights: [], key_findings: [], per_source_char_cap: 3000, total_sources_char_cap: 40000, sections: { overview: { key_findings: [], cross_references: [] }, gaps: [] }, query_type: 'general' as const }, provenance: [] };
    const { host } = makeHost([], { synthesizeSession: () => dto });
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    expect(await host.synthesizeSession()).toEqual(dto);
  });

  it('synthesizeSession degrades to an honest empty when the broker is down (never errors the UI)', async () => {
    const { host } = makeHost([], { synthesizeSession: () => { throw new Error('broker down'); } });
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' });
    expect(await host.synthesizeSession()).toEqual({ empty: true });
  });

  it('a NON-credential navigate is ALSO persisted origin-only — a query-string secret never lands in the audit row', async () => {
    // Security (adversarial finding): the strip must be UNCONDITIONAL, not gated on the credential
    // classifier — a reset/SSO/session token in a query string leaks on ANY page the classifier misses.
    const broadcasts: Record<string, unknown>[] = [];
    const { host, broker } = makeHost(broadcasts);
    await host.handlers.spawn({ startUrl: 'https://ex.com/page' }); // a plain, non-credential page
    await host.handlers.act({ action: 'navigate', url: 'https://ex.com/reset?token=SECRET_RESET_TOKEN' });

    await vi.waitFor(() => expect(persistedEntries(broker).some((e) => e.action === 'navigate')).toBe(true));
    const nav = persistedEntries(broker).find((e) => e.action === 'navigate')!;
    expect(nav.target?.url).toBe('https://ex.com');
    expect(nav.target?.url).not.toContain('SECRET_RESET_TOKEN');
    // the live broadcast is likewise origin-only (never the token)
    const wire = broadcasts.find((b) => b.t === 'audit' && b.action === 'navigate') as { url?: string } | undefined;
    expect(wire?.url).toBe('https://ex.com');
  });
});
