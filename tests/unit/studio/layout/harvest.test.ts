import { describe, it, expect } from 'vitest';
import { harvestLayout, type LayoutCdp } from '../../../../src/studio/layout/harvest.js';
import { computeLayoutSignature, serializeLayoutSignature } from '../../../../src/studio/layout/signature.js';

interface Call { method: string; params?: Record<string, unknown> }

/**
 * A counting fake transport. The round-trip budget (G-S11a-2) is asserted on THIS counter and
 * not on a timing measurement: a counter on the injected transport cannot agree with the
 * implementation by accident the way a wall-clock number can.
 */
function fakeCdp(response: unknown, calls: Call[]): LayoutCdp {
  return {
    async send(method, params) {
      calls.push({ method, params });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

const snapshotResponse = (opts: { scrollOffsetX?: number; scrollOffsetY?: number; extraDocument?: boolean } = {}) => ({
  strings: ['', 'Hello world', 'A much longer paragraph of body copy'],
  documents: [
    {
      scrollOffsetX: opts.scrollOffsetX ?? 0,
      scrollOffsetY: opts.scrollOffsetY ?? 0,
      contentWidth: 1200,
      contentHeight: 2400,
      layout: {
        nodeIndex: [1, 2, 3],
        bounds: [[0, 0, 1200, 80], [40, 120, 500, 300], [600, 120, 500, 300]],
        text: [-1, 1, 2],
      },
    },
    ...(opts.extraDocument
      ? [{
          scrollOffsetX: 0, scrollOffsetY: 0, contentWidth: 400, contentHeight: 400,
          layout: { nodeIndex: [1], bounds: [[0, 0, 400, 400]], text: [1] },
        }]
      : []),
  ],
});

describe('harvestLayout — D4: one CDP round trip per page, never one per node', () => {
  it('G-S11a-2: harvesting a whole page issues EXACTLY ONE CDP send, and it is the one-shot layout capture', async () => {
    const calls: Call[] = [];
    const r = await harvestLayout(fakeCdp(snapshotResponse(), calls));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DOMSnapshot.captureSnapshot');
  });

  it('maps layout bounds and string-indexed text into the quantiser input, so a text-bearing box carries its length', async () => {
    const calls: Call[] = [];
    const r = await harvestLayout(fakeCdp(snapshotResponse(), calls));
    if (!r.ok) throw new Error('expected ok');
    expect(r.input.boxes).toHaveLength(3);
    expect(r.input.boxes[0]).toMatchObject({ x: 0, y: 0, width: 1200, height: 80, textLength: 0 });
    expect(r.input.boxes[1].textLength).toBe('Hello world'.length);
    expect(r.input.boxes[2].textLength).toBe('A much longer paragraph of body copy'.length);
    expect(r.input.viewport).toMatchObject({ width: 1200, height: 2400, devicePixelRatio: 1 });
  });

  it('is invariant to scroll position: captured bounds are document-relative, so scrolling between two captures cannot move the signature', async () => {
    const top = await harvestLayout(fakeCdp(snapshotResponse({ scrollOffsetY: 0 }), []));
    const scrolled = await harvestLayout(fakeCdp(snapshotResponse({ scrollOffsetY: 1800, scrollOffsetX: 40 }), []));
    if (!top.ok || !scrolled.ok) throw new Error('expected ok');
    expect(serializeLayoutSignature(computeLayoutSignature(scrolled.input)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(top.input)));
  });

  it('takes geometry from the MAIN document only — a subframe reports its own coordinate space and would inject boxes that never share an origin', async () => {
    const withFrame = await harvestLayout(fakeCdp(snapshotResponse({ extraDocument: true }), []));
    const withoutFrame = await harvestLayout(fakeCdp(snapshotResponse(), []));
    if (!withFrame.ok || !withoutFrame.ok) throw new Error('expected ok');
    expect(withFrame.input.boxes).toHaveLength(3);
    expect(serializeLayoutSignature(computeLayoutSignature(withFrame.input)))
      .toBe(serializeLayoutSignature(computeLayoutSignature(withoutFrame.input)));
  });

  it('reports a failed or empty capture as DATA — a rejecting transport is never rethrown at the caller', async () => {
    const failed = await harvestLayout(fakeCdp(new Error('Protocol error'), []));
    expect(failed).toEqual({ ok: false, reason: 'capture_failed' });
    const empty = await harvestLayout(fakeCdp({ strings: [], documents: [] }, []));
    expect(empty).toEqual({ ok: false, reason: 'empty_snapshot' });
    const garbage = await harvestLayout(fakeCdp({ nope: true }, []));
    expect(garbage).toEqual({ ok: false, reason: 'empty_snapshot' });
  });
});
