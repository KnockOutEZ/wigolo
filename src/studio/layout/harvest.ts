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
 * bounds in LAYOUT px (NOT CSS px — see the units note at the viewport derivation below), plus a
 * string table the text index points into.
 *
 * Document-relative is what makes the signature scroll-invariant, and that was measured against a
 * real browser rather than assumed: scrolling to y=500 left all bounds byte-identical while the
 * reply's own `scrollOffsetY` moved 0 -> 500 and a viewport-relative control moved with the scroll.
 * The offset is deliberately never read — it is in layout px too, so reading it would have carried
 * a second unit bug in with it. Untested and therefore not claimed: a `position: fixed` element, a
 * scrolling sub-container, and subframes (this reads one document).
 *
 * Text length attaches to TEXT rows, not to element rows — an element's own layout row carries a
 * text index of -1 and the string lands on the inline text node's row. That is why text is read per
 * layout row here, index-aligned with `bounds`, rather than per element.
 *
 * This module takes the transport as a parameter and returns DATA. It composes nothing and calls
 * no consumer: the primitive has to be usable before visual heal, visual watch or look-alike exist.
 */
import { type LayoutBox, type LayoutInput, type LayoutViewport } from './signature.js';

export interface LayoutCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
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
export async function harvestLayout(cdp: LayoutCdp): Promise<HarvestResult> {
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

  // Every box is passed through: the quantiser's `sanitize` is the SINGLE authority on truncation,
  // and it reports the truncation via `clamped`. Pre-truncating here at exactly the same cap meant
  // `sanitize`'s `length > MAX_LAYOUT_BOXES` test could never fire, so a 50,000-box page arrived
  // looking like a clean 20,000-box one — the field that exists so a caller can distrust the vector
  // was silenced on the only path that would ever set it. `bounds` is already materialised from the
  // CDP reply, so iterating all of it costs no extra memory.
  const boxes: LayoutBox[] = [];
  for (let i = 0; i < bounds.length; i++) {
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

  // UNITS — the reason this is correct is not the obvious one, so it is written down.
  //
  // UNITS — measured against a real browser, because the obvious reading is wrong.
  //
  // These bounds are NOT CSS px. The layout-snapshot capture reads the absolute bounding box
  // directly, skipping the adjustment `getBoundingClientRect()` applies, so a bound is
  // LAYOUT px = CSS px x device scale factor. Measured: at a real scale factor of 2 the same
  // element reads [200,100,400,80] here and [100,50,200,40] from `getBoundingClientRect`. The two
  // APIs disagree, and that disagreement IS the factor. At scale factor 1 they coincide, which is
  // exactly why the mistake is invisible in ordinary testing.
  //
  // Reporting `devicePixelRatio: 1` is nonetheless correct here, and for a reason worth stating:
  // `contentWidth`/`contentHeight` were measured to scale too (800/3000 -> 1600/6000 at factor 2),
  // so the extent and the boxes live in the SAME layout-px space, scale together, and the factor
  // divides out in the normalisation. It is right because both sides share a space, NOT because
  // that space is CSS px.
  //
  // That cancellation is also why this function accepts no caller-supplied viewport. The obvious
  // source for one is `Page.getLayoutMetrics()`, which is CSS px; mixing a CSS-px extent with
  // layout-px bounds breaks whenever the content is less than half the viewport in an axis, and
  // would reintroduce the DPR bug this codebase already documents once, at
  // `src/studio/perception/resolve.ts:75-83`. If a caller ever needs to supply metrics, they must
  // be in layout px or carry the true factor, and the parameter must say which.
  //
  // Not covered by the measurement, so not claimed: browser UI zoom (it is unreachable over the
  // debug protocol), a physical HiDPI display, and non-Chromium engines. The numbers above are
  // specific to the build they were taken on.
  const viewport: LayoutViewport = {
    width: num(doc?.contentWidth),
    height: num(doc?.contentHeight),
    devicePixelRatio: 1,
  };
  return { ok: true, input: { boxes, viewport } };
}
