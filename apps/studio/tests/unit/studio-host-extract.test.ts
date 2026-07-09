import { describe, it, expect, vi } from 'vitest';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import { createDriveEngine } from '../../src/main/drive-engine';
import { createStudioHost, type HostTab } from '../../src/main/studio-host';
import { makeFakeBroker } from '../helpers/fake-broker';
import type { MarkPayload, StudioExtractSetOutput, StudioToolError } from 'wigolo/studio';

/**
 * P6 F1 — the studio_extract_set HOST wiring. The core row-inference + orchestration is unit-tested in
 * src/studio/extract-set.ts; these tests target the HOST-specific guarantees the core cannot see:
 * tab_id→session resolution (confused-deputy fence), credential-refuse-at-source (broker never called),
 * broker persist wiring, and that pagination follow routes through the gated nav choke (browser.navigate is
 * the choke's endpoint — an ungranted private next-target never reaches it).
 */
const viewport = () => ({ width: 800, height: 600 });
const samplePayload: MarkPayload = {
  tag: 'a', id: '', classes: ['card'], attrs: { href: '/plan' }, dataset: {},
  text: 'plan', component: null, source: null,
};

const attrsArr = (o: Record<string, string> = {}): string[] => Object.entries(o).flat();
const txt = (be: number, v: string) => ({ backendNodeId: be, nodeType: 3, nodeName: '#text', nodeValue: v, children: [] });
const el = (be: number, localName: string, attrs: Record<string, string> = {}, children: unknown[] = []) =>
  ({ backendNodeId: be, nodeType: 1, localName, nodeName: localName.toUpperCase(), attributes: attrsArr(attrs), children });

/** A repeating-cards fixture: three `div.card` (be 20/30/40), each `h3 + span` with real text nodes, so a
 *  mark on one card generalizes to all three and row inference finds columns [h3, span]. `next` adds a
 *  paginate link whose href is opts.nextHref (to prove the follow routes through the gated nav choke). */
function extractDebugger(opts: { nextHref?: string } = {}): DebuggerLike {
  let attached = false;
  // The repeating element is an interactive link (so buildSnapshot assigns it a ref → generalize candidate),
  // containing an h3 + span with text so row inference derives columns from the shared sub-structure.
  const card = (be: number, title: string, price: string) =>
    el(be, 'a', { class: 'card', href: '#' }, [
      el(be + 1, 'h3', {}, [txt(be + 11, title)]),
      el(be + 2, 'span', {}, [txt(be + 12, price)]),
    ]);
  const build = () => {
    const bodyKids: unknown[] = [card(20, 'Pro', '$20'), card(30, 'Team', '$40'), card(40, 'Free', '$0')];
    const ax: Array<{ ignored: boolean; role: { value: string }; name: { value: string }; backendDOMNodeId: number }> = [
      { ignored: false, role: { value: 'link' }, name: { value: 'plan' }, backendDOMNodeId: 20 },
      { ignored: false, role: { value: 'link' }, name: { value: 'plan' }, backendDOMNodeId: 30 },
      { ignored: false, role: { value: 'link' }, name: { value: 'plan' }, backendDOMNodeId: 40 },
    ];
    if (opts.nextHref) {
      bodyKids.push(el(50, 'a', { href: opts.nextHref }, [txt(51, 'Next')]));
      ax.push({ ignored: false, role: { value: 'link' }, name: { value: 'Next' }, backendDOMNodeId: 50 });
    }
    return { nodes: ax, root: { backendNodeId: 1, nodeType: 9, nodeName: '#document', children: [el(2, 'html', {}, [el(3, 'body', {}, bodyKids)])] } };
  };
  const box = (be: number) => { const y = be; return { content: [10, y, 110, y, 110, y + 20, 10, y + 20] }; };
  return {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case 'Accessibility.getFullAXTree': return { nodes: build().nodes };
        case 'DOM.getDocument': return { root: build().root };
        case 'DOM.getBoxModel': return { model: box(Number(params?.backendNodeId)) };
        case 'Page.getLayoutMetrics': return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        default: return {};
      }
    },
    on: () => {},
    removeListener: () => {},
  };
}

function emptyDebugger(): DebuggerLike {
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
    on: () => {},
    removeListener: () => {},
  };
}

function makeHost(dbg: () => DebuggerLike, broker = makeFakeBroker(), grantPrivate = false) {
  const engine = createDriveEngine();
  const tabs = new Map<string, { navigate: ReturnType<typeof vi.fn>; url: string }>();
  let n = 0;
  const host = createStudioHost({
    broker,
    onParked: () => {},
    createTab: async ({ initialHolder, grant }) => {
      const tabId = `t${++n}`;
      if (grantPrivate) grant.agentAllowPrivate = true; // simulate the human's localhost grant
      const drive = await engine.attachTab(tabId, { debugger: dbg(), viewport, grant, initialHolder });
      const state = { navigate: vi.fn(async (u: string) => { state.url = u; }), url: 'about:blank' };
      tabs.set(tabId, state);
      const tab: HostTab = {
        tabId, drive,
        browser: { navigate: (u) => state.navigate(u) },
        currentUrl: () => state.url,
        readHtml: async () => '<html></html>',
        storageState: async () => ({ cookies: [], origins: [] }),
        applyStorageState: async () => {},
      };
      return tab;
    },
    closeTab: () => {},
  });
  return { host, tabs };
}

const isErr = (x: StudioExtractSetOutput | StudioToolError): x is StudioToolError => 'error_reason' in x;

describe('studio_extract_set — host wiring (P6 F1)', () => {
  it('POSITIVE: marks a repeating card, extracts N rows with inferred columns, and persists via the broker', async () => {
    const broker = makeFakeBroker();
    const { host } = makeHost(extractDebugger, broker);
    await host.handlers.spawn({ startUrl: 'https://shop.test/plans' });
    const created = await host.markElement({ tabId: 't1', path: [0, 0], payload: samplePayload });
    expect('markId' in created).toBe(true);
    const markId = (created as { markId: string }).markId;
    const out = await host.handlers.extractSet({ tab_id: 't1', mark_id: markId });
    expect(isErr(out)).toBe(false);
    if (!isErr(out)) {
      expect(out.rows.length).toBe(3);
      expect(out.columns.length).toBeGreaterThanOrEqual(1);
    }
    expect(broker.call).toHaveBeenCalledWith('persistExtraction', expect.objectContaining({ url: 'https://shop.test/plans' }));
  });

  it('POSITIVE: omitting tab_id defaults to the active session (the agent has no tab_id to pass)', async () => {
    const broker = makeFakeBroker();
    const { host } = makeHost(extractDebugger, broker);
    await host.handlers.spawn({ startUrl: 'https://shop.test/plans' });
    const created = await host.markElement({ tabId: 't1', path: [0, 0], payload: samplePayload });
    const markId = (created as { markId: string }).markId;
    const out = await host.handlers.extractSet({ mark_id: markId }); // no tab_id
    expect(isErr(out)).toBe(false);
    if (!isErr(out)) expect(out.rows.length).toBe(3);
  });

  it('NEGATIVE confused-deputy (b): a tab_id of a NON-active session is rejected (wrong_session), never coerced', async () => {
    const { host } = makeHost(extractDebugger);
    await host.handlers.spawn({ startUrl: 'https://shop.test/a' }); // t1 = session A
    await host.handlers.spawn({ startUrl: 'https://shop.test/b' }); // t2 = session B, now ACTIVE
    const out = await host.handlers.extractSet({ tab_id: 't1', mark_id: 'anything' }); // t1 is no longer active
    expect(isErr(out) && out.error_reason).toBe('wrong_session');
  });

  it('NEGATIVE confused-deputy (a): a mark_id not in the active tab\'s store → no_such_mark (host-wide-unique ids)', async () => {
    const { host } = makeHost(extractDebugger);
    await host.handlers.spawn({ startUrl: 'https://shop.test/plans' });
    const out = await host.handlers.extractSet({ tab_id: 't1', mark_id: 'm-from-another-session' });
    expect(isErr(out) && out.error_reason).toBe('no_such_mark');
  });

  it('NEGATIVE credential: on a login page it refuses at source and NEVER calls the broker', async () => {
    const broker = makeFakeBroker();
    const { host } = makeHost(extractDebugger, broker);
    await host.handlers.spawn({ startUrl: 'https://shop.test/login' }); // login URL → isCredentialPage true
    const out = await host.handlers.extractSet({ tab_id: 't1', mark_id: 'whatever' });
    expect(isErr(out)).toBe(false);
    if (!isErr(out)) expect(out.stage).toBe('refused');
    expect(broker.call).not.toHaveBeenCalledWith('persistExtraction', expect.anything());
  });

  it('NEGATIVE pagination SSRF: an ungranted private next-target is NOT navigated (gated choke refuses before browser.navigate)', async () => {
    const broker = makeFakeBroker();
    const { host, tabs } = makeHost(() => extractDebugger({ nextHref: 'http://169.254.169.254/latest' }), broker, false);
    await host.handlers.spawn({ startUrl: 'https://shop.test/plans' });
    const created = await host.markElement({ tabId: 't1', path: [0, 0], payload: samplePayload });
    const markId = (created as { markId: string }).markId;
    await host.handlers.extractSet({ tab_id: 't1', mark_id: markId, follow_pagination: true, max_pages: 3 });
    const navUrls = tabs.get('t1')!.navigate.mock.calls.map((c) => c[0]);
    // cloud-metadata is hard-blocked by guardNavigation regardless of grant → the follow never reaches browser.navigate.
    expect(navUrls.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });
});
