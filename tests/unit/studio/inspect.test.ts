import { describe, it, expect } from 'vitest';
import { createInspector } from '../../../src/studio/mark/inspect.js';
import type { StructuredTarget } from '../../../src/studio/mark/target.js';

const aTarget: StructuredTarget = {
  backendNodeId: 3,
  role: 'button',
  name: 'Buy',
  trusted: false,
  fingerprint: 'fp',
  ancestorPath: 'body/div/button',
  attrs: {},
};

function makeFakeCdp() {
  const sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  let handler: ((p: unknown) => void) | undefined;
  return {
    cdp: {
      send: async (method: string, params?: Record<string, unknown>) => {
        sends.push({ method, params: params ?? {} });
        return {};
      },
      on: (event: string, h: (p: unknown) => void) => {
        if (event === 'Overlay.inspectNodeRequested') handler = h;
      },
      off: () => {
        handler = undefined;
      },
    },
    sends,
    pick: (backendNodeId?: number) => handler?.({ backendNodeId }),
  };
}

describe('createInspector — Overlay-driven mark capture', () => {
  it('enable() arms inspect mode (Overlay.enable then setInspectMode searchForNode)', async () => {
    const f = makeFakeCdp();
    const insp = createInspector({ cdp: () => f.cdp, resolveMark: async () => aTarget, onMark: () => {} });
    await insp.enable();
    expect(f.sends.map((s) => s.method)).toEqual(['DOM.enable', 'Overlay.enable', 'Overlay.setInspectMode']);
    expect(f.sends[2].params).toMatchObject({ mode: 'searchForNode' });
  });

  it('on a pick: resolves the node to a structured target, emits it, and turns inspect mode OFF', async () => {
    const f = makeFakeCdp();
    const marks: StructuredTarget[] = [];
    const insp = createInspector({ cdp: () => f.cdp, resolveMark: async (be) => ({ ...aTarget, backendNodeId: be }), onMark: (t) => marks.push(t) });
    await insp.enable();
    f.sends.length = 0;
    await f.pick(42);
    await new Promise((r) => setImmediate(r)); // let the async resolveMark settle
    expect(marks).toHaveLength(1);
    expect(marks[0].backendNodeId).toBe(42);
    // inspect mode disarmed after the pick (one mark per enable)
    expect(f.sends.some((s) => s.method === 'Overlay.setInspectMode' && s.params.mode === 'none')).toBe(true);
  });

  it('binds the inspect listener on the LIVE cdp each enable (so it follows a crash-recovery rebind)', async () => {
    const dead = makeFakeCdp();
    const fresh = makeFakeCdp();
    let cur = dead;
    const marks: StructuredTarget[] = [];
    const insp = createInspector({ cdp: () => cur.cdp, resolveMark: async (be) => ({ ...aTarget, backendNodeId: be }), onMark: (t) => marks.push(t) });
    cur = fresh; // a crash recovery swapped the session cdp before the human marks
    await insp.enable();
    await dead.pick(1); // the dead session can't deliver a pick
    await fresh.pick(99); // the live one does
    await new Promise((r) => setImmediate(r));
    expect(marks.map((m) => m.backendNodeId)).toEqual([99]);
  });

  it('a pick with no backendNodeId emits nothing', async () => {
    const f = makeFakeCdp();
    const marks: StructuredTarget[] = [];
    const insp = createInspector({ cdp: () => f.cdp, resolveMark: async () => aTarget, onMark: (t) => marks.push(t) });
    await insp.enable();
    await f.pick(undefined);
    await new Promise((r) => setImmediate(r));
    expect(marks).toHaveLength(0);
  });

  it('a pick that does not resolve to a target (gone/unbuildable) emits nothing — never a wrong mark', async () => {
    const f = makeFakeCdp();
    const marks: StructuredTarget[] = [];
    const insp = createInspector({ cdp: () => f.cdp, resolveMark: async () => null, onMark: (t) => marks.push(t) });
    await insp.enable();
    await f.pick(7);
    await new Promise((r) => setImmediate(r));
    expect(marks).toHaveLength(0);
  });
});
