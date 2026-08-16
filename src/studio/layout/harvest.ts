/**
 * S11a — the layout HARVEST. D4: one CDP round trip per page, never one per node.
 *
 * The existing geometry read (`boxForNode`) is one `DOM.getBoxModel` per node, awaited serially.
 * On the page size the perception layer was measured against (~900 interactive elements) that is
 * ~900 sequential round trips for a single signature, which is why the harvest is a NEW capture
 * path rather than a new consumer of the existing one. `boxForNode` stays exactly as it is for the
 * generalize path — a per-element read for a handful of matches is a different problem.
 *
 * `DOMSnapshot.captureSnapshot` returns the whole layout tree in one reply: document-relative
 * bounds in CSS px, plus a string table the text index points into. Document-relative is what makes
 * the signature scroll-invariant — the scroll offset is reported in the same reply and is
 * deliberately never read.
 *
 * This module takes the transport as a parameter and returns DATA. It composes nothing and calls
 * no consumer: the primitive has to be usable before visual heal, visual watch or look-alike exist.
 */
import { MAX_LAYOUT_BOXES, type LayoutBox, type LayoutInput, type LayoutViewport } from './signature.js';

export interface LayoutCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface HarvestOptions {
  /**
   * Viewport metrics the caller ALREADY holds. Supplying them costs no extra round trip; omitting
   * them falls back to the captured document's own content box, which is also CSS px.
   */
  viewport?: LayoutViewport;
}

export type HarvestFailure = 'capture_failed' | 'empty_snapshot';

export type HarvestResult =
  | { ok: true; input: LayoutInput }
  | { ok: false; reason: HarvestFailure };

interface RawLayout {
  bounds?: unknown;
  text?: unknown;
}

interface RawDocument {
  layout?: RawLayout;
  contentWidth?: unknown;
  contentHeight?: unknown;
}

interface RawSnapshot {
  documents?: unknown;
  strings?: unknown;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

/** ONE send. The whole D4 budget is this function having exactly one `await cdp.send`. */
export async function harvestLayout(cdp: LayoutCdp, opts: HarvestOptions = {}): Promise<HarvestResult> {
  let raw: RawSnapshot;
  try {
    raw = (await cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: false,
      includePaintOrder: false,
    })) as RawSnapshot;
  } catch {
    return { ok: false, reason: 'capture_failed' }; // a rejecting transport is reported as data, not thrown
  }

  const documents = Array.isArray(raw?.documents) ? (raw.documents as RawDocument[]) : [];
  const strings = Array.isArray(raw?.strings) ? (raw.strings as unknown[]) : [];
  // MAIN document only. A subframe's bounds are in ITS OWN coordinate space, so merging them would
  // place boxes on the grid at positions that never shared an origin with the page's.
  const doc = documents[0];
  const bounds = Array.isArray(doc?.layout?.bounds) ? (doc!.layout!.bounds as unknown[]) : null;
  if (!bounds || bounds.length === 0) return { ok: false, reason: 'empty_snapshot' };
  const textIdx = Array.isArray(doc?.layout?.text) ? (doc!.layout!.text as unknown[]) : [];

  const limit = Math.min(bounds.length, MAX_LAYOUT_BOXES);
  const boxes: LayoutBox[] = [];
  for (let i = 0; i < limit; i++) {
    const b = bounds[i];
    if (!Array.isArray(b) || b.length < 4) continue;
    const si = num(textIdx[i]);
    const s = Number.isInteger(si) && si >= 0 && si < strings.length ? strings[si] : undefined;
    boxes.push({
      x: num(b[0]),
      y: num(b[1]),
      width: num(b[2]),
      height: num(b[3]),
      textLength: typeof s === 'string' ? s.length : 0,
    });
  }
  if (boxes.length === 0) return { ok: false, reason: 'empty_snapshot' };

  const viewport: LayoutViewport = opts.viewport ?? {
    width: num(doc?.contentWidth),
    height: num(doc?.contentHeight),
    devicePixelRatio: 1, // captureSnapshot bounds are CSS px
  };
  return { ok: true, input: { boxes, viewport } };
}
