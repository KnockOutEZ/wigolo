/**
 * The frozen L-DET corpus: its on-disk shape, its loader, and the COMPOSITION measurements that
 * decide which clauses it is allowed to be scored on.
 *
 * WHY COMPOSITION IS A FIRST-CLASS NUMBER HERE. `score.ts:122-131` records the defect this file
 * exists to close: the DPR clause's power is a property of which pages are in the corpus, not of the
 * metric, and a corpus missing the floor-binding archetype reports a PERFECT score for a build with
 * no DPR handling at all. A comment cannot enforce that. So the corpus carries its own adequacy
 * measurement, computed from the captured geometry, and `gate.ts` refuses to print a verdict for a
 * clause whose precondition the corpus does not meet. An unjudgeable clause says so; it never
 * silently reports a pass.
 *
 * What is stored is GEOMETRY ONLY — per box: x, y, width, height, and the LENGTH of its text. No
 * markup, no text, no styles, no images. That is what makes a real-page corpus vendorable at all
 * (`urls.ts:4-12`), and it is why the frozen file is auditable by reading it.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_LAYOUT_BOXES, type LayoutBox, type LayoutInput } from '../../src/studio/layout/signature.js';

/** The four renders L-DET requires of every page (spec §3, the L-DET row). */
export type RenderKind = 'ref_a' | 'ref_b' | 'alt_width' | 'dpr2';

export interface CapturedRender {
  kind: RenderKind;
  /** CSS viewport width the render was laid out at. */
  viewportWidth: number;
  /** Device scale factor the browser engine was driven at. */
  deviceScaleFactor: number;
  /** Exactly what the shipped harvest returned — the product's own view of the page. */
  input: LayoutInput;
  /** Round trips the harvest spent. G-S11a-2's outside signal, counted at capture time. */
  sends: number;
  /** Wall-clock ms for the harvest call itself. */
  harvestMs: number;
  /** Boxes past the quantiser's own cap that the frozen file does not carry. */
  boxesDropped?: number;
}

export interface CapturedPage {
  url: string;
  /** The `urls.ts` group this page was seeded from — the composition axis. */
  group: string;
  renders: CapturedRender[];
}

export interface CorpusProvenance {
  capturedAt: string;
  browserEngine: string;
  browserVersion: string;
  platform: string;
  /** The width every reference render is laid out at. */
  refWidth: number;
  /** The SECOND width the gate is scored at — the number G-S11a-1 clause 2's verdict is a function of. */
  altWidth: number;
  /** Every width the alternate render was captured at, so the pin above can be argued from a sweep. */
  altWidthSweep: number[];
  viewportHeight: number;
  /** Seeds attempted, and what failed, so a shrinking corpus is visible rather than silent. */
  attempted: number;
  failures: Array<{ url: string; reason: string }>;
}

export interface FrozenCorpus {
  version: 1;
  provenance: CorpusProvenance;
  pages: CapturedPage[];
}

// `fileURLToPath`, not `.pathname`: on Windows the latter yields `/C:/...`, which every `fs` call
// then fails to open. The corpus is read by CI on three platforms, so this is a real path and not
// a hypothetical one.
export const CORPUS_PATH = fileURLToPath(new URL('./corpus/l-det.json.gz', import.meta.url));

/** Boxes are stored as flat tuples: the JSON is ~4x smaller than an array of objects and reads the same. */
type WireBox = [number, number, number, number, number];

function toWire(b: LayoutBox): WireBox {
  // Rounded to whole pixels. Layout bounds arrive at sub-pixel precision, and the finest grid the
  // gate sweeps is 16 columns — an 80px cell at the reference viewport — so a whole pixel is nearly
  // two orders of magnitude below anything the metric can resolve. It is also what makes the frozen
  // corpus small enough to live in the repo, which is the property that lets a verdict be re-checked
  // at all rather than re-captured against a web that has moved on.
  const r = (n: number) => (Number.isFinite(n) ? Math.round(n) : n);
  return [r(b.x), r(b.y), r(b.width), r(b.height), b.textLength ?? 0];
}

/**
 * The quantiser truncates at `MAX_LAYOUT_BOXES` and records that it did via `clamped`, so a box
 * beyond the cap cannot reach any number the gate prints. Storing ONE box past the cap rather than
 * exactly the cap is deliberate: `harvest.ts:82-88` records that pre-truncating at exactly the cap
 * silenced the very flag that exists to tell a caller the vector is partial, and freezing the corpus
 * at the cap would reintroduce that silence in the corpus instead of in the harvest.
 */
const STORED_BOX_CAP = MAX_LAYOUT_BOXES + 1;

function fromWire(w: WireBox): LayoutBox {
  return { x: w[0], y: w[1], width: w[2], height: w[3], textLength: w[4] };
}

export function writeCorpus(corpus: FrozenCorpus, path = CORPUS_PATH): number {
  const wire = {
    version: corpus.version,
    provenance: corpus.provenance,
    pages: corpus.pages.map((p) => ({
      url: p.url,
      group: p.group,
      renders: p.renders.map((r) => ({
        kind: r.kind,
        viewportWidth: r.viewportWidth,
        deviceScaleFactor: r.deviceScaleFactor,
        sends: r.sends,
        harvestMs: Math.round(r.harvestMs * 100) / 100,
        viewport: r.input.viewport,
        boxes: r.input.boxes.slice(0, STORED_BOX_CAP).map(toWire),
        // Boxes the quantiser would have discarded anyway; recorded so the truncation is visible.
        boxesDropped: Math.max(0, r.input.boxes.length - STORED_BOX_CAP),
      })),
    })),
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(wire), 'utf8'), { level: 9 });
  writeFileSync(path, gz);
  return gz.byteLength;
}

export function loadCorpus(path = CORPUS_PATH): FrozenCorpus {
  const raw = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
  return {
    version: raw.version,
    provenance: raw.provenance,
    pages: raw.pages.map((p: any) => ({
      url: p.url,
      group: p.group,
      renders: p.renders.map((r: any) => ({
        kind: r.kind,
        viewportWidth: r.viewportWidth,
        deviceScaleFactor: r.deviceScaleFactor,
        sends: r.sends,
        harvestMs: r.harvestMs,
        input: { boxes: r.boxes.map(fromWire), viewport: r.viewport },
        boxesDropped: r.boxesDropped ?? 0,
      })),
    })),
  };
}

export function renderOf(page: CapturedPage, kind: RenderKind, width?: number): LayoutInput | null {
  return page.renders.find((r) => r.kind === kind && (width === undefined || r.viewportWidth === width))?.input ?? null;
}

/**
 * Pages carrying every render the gate scores. A page missing one render is dropped ENTIRELY rather
 * than scored on the clauses it can still answer: a corpus whose clauses are each scored over a
 * different subset is not one corpus, and two clauses could then disagree for no reason but which
 * pages happened to load.
 */
export function completePages(corpus: FrozenCorpus): CapturedPage[] {
  const need: RenderKind[] = ['ref_a', 'ref_b', 'dpr2'];
  const widths = corpus.provenance.altWidthSweep ?? [corpus.provenance.altWidth];
  return corpus.pages.filter(
    (p) =>
      need.every((k) => p.renders.some((r) => r.kind === k)) &&
      widths.every((w) => p.renders.some((r) => r.kind === 'alt_width' && r.viewportWidth === w)),
  );
}

/**
 * Does the extent normalisation's VIEWPORT FLOOR bind on this render?
 *
 * `signature.ts:232-233` takes `extent = max(viewport, contentEdge, 1)` per axis. When the content
 * reaches or passes the viewport edge the extent IS the content edge, so it scales with any uniform
 * scaling of the input and divides that scaling straight back out. Only when the floor binds — the
 * content strictly inside the viewport on that axis — does a uniform scaling change the normalised
 * coordinates at all. That is the exact condition under which a DPR mutation is OBSERVABLE, which is
 * why it is measured per render instead of inferred from a page's archetype name.
 */
export function floorBinds(input: LayoutInput): { x: boolean; y: boolean } {
  let maxRight = 0;
  let maxBottom = 0;
  for (const b of input.boxes) {
    const w = Number.isFinite(b.width) ? Math.max(0, b.width) : 0;
    const h = Number.isFinite(b.height) ? Math.max(0, b.height) : 0;
    if (Number.isFinite(b.x)) maxRight = Math.max(maxRight, b.x + w);
    if (Number.isFinite(b.y)) maxBottom = Math.max(maxBottom, b.y + h);
  }
  const vw = Number.isFinite(input.viewport.width) && input.viewport.width > 0 ? input.viewport.width : 0;
  const vh = Number.isFinite(input.viewport.height) && input.viewport.height > 0 ? input.viewport.height : 0;
  return { x: vw > maxRight, y: vh > maxBottom };
}

export interface Adequacy {
  pages: number;
  groups: Record<string, number>;
  /** Pages whose reference render has the floor binding on BOTH axes. */
  floorBindingBoth: number;
  floorBindingEitherAxis: number;
  /** Renders reporting a device pixel ratio other than 1 — the only shape the DPR division acts on. */
  rendersWithNonUnitDpr: number;
  medianBoxes: number;
}

export function measureAdequacy(corpus: FrozenCorpus): Adequacy {
  const pages = completePages(corpus);
  const groups: Record<string, number> = {};
  let both = 0;
  let either = 0;
  let nonUnit = 0;
  const boxCounts: number[] = [];
  for (const p of pages) {
    groups[p.group] = (groups[p.group] ?? 0) + 1;
    const ref = renderOf(p, 'ref_a');
    if (ref) {
      const f = floorBinds(ref);
      if (f.x && f.y) both++;
      if (f.x || f.y) either++;
      boxCounts.push(ref.boxes.length);
    }
    for (const r of p.renders) if (r.input.viewport.devicePixelRatio !== 1) nonUnit++;
  }
  boxCounts.sort((a, b) => a - b);
  return {
    pages: pages.length,
    groups,
    floorBindingBoth: both,
    floorBindingEitherAxis: either,
    rendersWithNonUnitDpr: nonUnit,
    medianBoxes: boxCounts.length ? boxCounts[Math.floor(boxCounts.length / 2)] : 0,
  };
}

/** The corpus size L-DET mandates (spec §3, "≥ 30 pages"). */
export const MIN_CORPUS_PAGES = 30;

/**
 * The DPR clause's precondition, as a checkable proposition rather than a comment.
 *
 * A DPR mutation is observable only on a render where the floor binds (see `floorBinds`) AND whose
 * reported ratio is not 1 (the division is the identity otherwise). A corpus meeting neither cannot
 * distinguish a build with DPR handling from one without, so a score taken from it is not evidence.
 * Requiring THREE such pages rather than one is deliberate: at one page a single capture failure
 * silently returns the corpus to the blind state this check exists to detect.
 */
export const MIN_FLOOR_BINDING_PAGES = 3;

export function dprClauseJudgeable(a: Adequacy): { judgeable: boolean; reason: string } {
  if (a.rendersWithNonUnitDpr === 0) {
    return {
      judgeable: false,
      reason:
        'no captured render reports a device pixel ratio other than 1, so the ratio division is the ' +
        'identity on every page here and its removal cannot change any number',
    };
  }
  if (a.floorBindingBoth < MIN_FLOOR_BINDING_PAGES) {
    return {
      judgeable: false,
      reason:
        `only ${a.floorBindingBoth} page(s) have the extent floor binding on both axes ` +
        `(need ${MIN_FLOOR_BINDING_PAGES}); everywhere else the extent divides a uniform scaling out on its own`,
    };
  }
  return { judgeable: true, reason: 'floor-binding pages present and ratios other than 1 reported' };
}
