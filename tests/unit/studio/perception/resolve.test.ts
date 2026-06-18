import { describe, it, expect } from 'vitest';
import { createResolver, isResolveError, type ResolveResult } from '../../../../src/studio/perception/resolve.js';
import type { PageSnapshot, SnapshotElement } from '../../../../src/studio/perception/snapshot.js';

function makeSnapshot(opts: {
  elements: SnapshotElement[];
  refMap: Array<[string, number]>;
  domParent: Array<[number, number | null]>;
}): PageSnapshot {
  return {
    id: 's1',
    elements: opts.elements,
    tokenCount: 0,
    overBudget: false,
    domTruncated: false,
    refMap: new Map(opts.refMap),
    groupByRef: new Map(),
    domParent: new Map(opts.domParent),
  };
}

/** Fake CDP: canned getBoxModel + getNodeForLocation; records sends so order is assertable. */
function makeCdp(opts: { boxByBe?: Record<number, number[] | null>; topAt?: number | null }) {
  const sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      sends.push({ method, params: params ?? {} });
      if (method === 'DOM.getBoxModel') {
        const be = (params?.backendNodeId as number) ?? -1;
        const content = opts.boxByBe?.[be];
        return content ? { model: { content } } : {};
      }
      if (method === 'DOM.getNodeForLocation') {
        return opts.topAt === null ? {} : { backendNodeId: opts.topAt };
      }
      return {};
    },
  };
  return { cdp, sends };
}

// A 20x10 box at (100,200): content quad corners → center (110, 205).
const BOX = [100, 200, 120, 200, 120, 210, 100, 210];

const asErr = (r: ResolveResult) => { expect(isResolveError(r)).toBe(true); return r as { error: string }; };

describe('createResolver — live ref → coordinates', () => {
  it('resolves a ref to the CURRENT element box center (live, via a fresh snapshot)', async () => {
    const f = makeCdp({ boxByBe: { 100: BOX }, topAt: 100 }); // target itself is topmost
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'e1', role: 'button', name: 'Go' }], refMap: [['e1', 100]], domParent: [[100, 1], [1, null]] }),
      cdp: f.cdp,
    });
    const r = await resolve('e1');
    expect(isResolveError(r)).toBe(false);
    expect(r).toEqual({ backendNodeId: 100, center: { x: 110, y: 205 } });
    expect(f.sends.some((s) => s.method === 'DOM.scrollIntoViewIfNeeded')).toBe(true); // brought on-screen first
  });

  it('NEVER uses cached coords: a moved element resolves to its NEW box on the next call', async () => {
    let box = BOX;
    let top = 100;
    const f = {
      cdp: {
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'DOM.getBoxModel') return { model: { content: box } };
          if (method === 'DOM.getNodeForLocation') return { backendNodeId: top };
          return {};
        },
      },
    };
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'e1', role: 'button', name: 'Go' }], refMap: [['e1', 100]], domParent: [[100, null]] }),
      cdp: f.cdp,
    });
    expect((await resolve('e1') as { center: unknown }).center).toEqual({ x: 110, y: 205 });
    box = [300, 400, 320, 400, 320, 410, 300, 410]; // the element moved
    expect((await resolve('e1') as { center: unknown }).center).toEqual({ x: 310, y: 405 }); // new box, not cached
  });

  it('a ref absent from the current snapshot → element_no_longer_present (never a different element)', async () => {
    const f = makeCdp({ boxByBe: { 100: BOX }, topAt: 100 });
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'eOTHER', role: 'button', name: 'Other' }], refMap: [['eOTHER', 100]], domParent: [[100, null]] }),
      cdp: f.cdp,
    });
    expect(asErr(await resolve('e1')).error).toBe('element_no_longer_present');
    expect(f.sends.length).toBe(0); // never touched the DOM for a wrong element
  });

  it('a low-confidence (identical-sibling) ref → element_low_confidence (ask/re-observe, do not silently act)', async () => {
    const f = makeCdp({ boxByBe: { 100: BOX }, topAt: 100 });
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'e1', role: 'button', name: 'Delete', confidence: 'low' }], refMap: [['e1', 100]], domParent: [[100, null]] }),
      cdp: f.cdp,
    });
    expect(asErr(await resolve('e1')).error).toBe('element_low_confidence');
    expect(f.sends.length).toBe(0); // never resolved coords for a low-confidence ref
  });

  it('a DIFFERENT node on top of the click point → element_occluded (overlay/modal between observe and act)', async () => {
    // topmost is 999 (an overlay), whose ancestor chain (999→998→root) does NOT include the target 100.
    const f = makeCdp({ boxByBe: { 100: BOX }, topAt: 999 });
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'e1', role: 'button', name: 'Go' }], refMap: [['e1', 100]], domParent: [[100, 1], [1, null], [999, 998], [998, null]] }),
      cdp: f.cdp,
    });
    expect(asErr(await resolve('e1')).error).toBe('element_occluded');
  });

  it('a DESCENDANT of the target on top → OK (the click lands on the target; e.g. a label span)', async () => {
    // topmost is 101, a child of the target 100 → click hits the target.
    const f = makeCdp({ boxByBe: { 100: BOX }, topAt: 101 });
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'e1', role: 'button', name: 'Go' }], refMap: [['e1', 100]], domParent: [[101, 100], [100, null]] }),
      cdp: f.cdp,
    });
    const r = await resolve('e1');
    expect(isResolveError(r)).toBe(false);
    expect((r as { backendNodeId: number }).backendNodeId).toBe(100);
  });

  it('an element with no box (not rendered/visible) → element_not_visible', async () => {
    const f = makeCdp({ boxByBe: { 100: null }, topAt: 100 });
    const resolve = createResolver({
      snapshot: async () => makeSnapshot({ elements: [{ ref: 'e1', role: 'button', name: 'Go' }], refMap: [['e1', 100]], domParent: [[100, null]] }),
      cdp: f.cdp,
    });
    expect(asErr(await resolve('e1')).error).toBe('element_not_visible');
  });
});
