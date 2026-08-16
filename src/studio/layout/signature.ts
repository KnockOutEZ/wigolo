/**
 * S11a — `LayoutSignature`: a stable identity for a PAGE'S LAYOUT, not a hash of its content.
 *
 * The whole point is that it must survive the things that change every time a page is loaded
 * (a headline edit, a timestamp, a rotated ad, a sub-pixel reflow) and must move when the page's
 * STRUCTURE changes (a redesign, a column collapse, a challenge interstitial replacing the body).
 * A signature that never collides is as broken as one that always does, so both directions are
 * stated here and tested in both directions.
 *
 * INVARIANT TO
 *  - device pixel ratio — box units are divided by the reported DPR before anything else, so a
 *    HiDPI capture signs identically to a 1x one (`resolve.ts:75-83` documents the same trap for
 *    the click path: the CSS-px field is the only one that is DPR-safe).
 *  - uniform scale — coordinates are normalised by the page's own extent, so a 3x larger render
 *    of the same layout is the same vector.
 *  - scroll position — the harvest reads DOCUMENT-relative bounds (see `harvest.ts`), so where the
 *    user happened to be scrolled to is not in the input at all.
 *  - text CONTENT — only text LENGTH enters, never the characters. Two different headlines of
 *    similar length are the same layout.
 *  - total text volume — each channel is normalised by its own maximum, so "the same page with
 *    more of the same" is the same profile.
 *  - harvest order — mass is accumulated, never sequenced.
 *
 * DISCRIMINATES ON
 *  - where mass sits on the page: a 3-column card grid, a left-rail docs page, and a centred
 *    3-element interstitial put their mass in different cells.
 *  - proportion, not pixels: a region that grows from a tenth of the page to half of it moves.
 *  - the presence or absence of a whole region (a sidebar, a footer).
 *  - a blank/failed render vs a real one (distance 1, never a near-match).
 *
 * D3 — normalised, quantised, fixed-length geometry + text density. NOT a perceptual image hash:
 * no pixels are read, no image dependency is added, and the geometry channel is immune to theme,
 * ad and lazy-image noise that would dominate a pixel channel.
 *
 * D5 — box geometry is PAGE-CONTROLLED. Every coordinate is clamped before it can reach a
 * division, and `trusted` is welded `false` at construction (the `StructuredTarget.trusted`
 * / `VisionResult.trusted` pattern), so the value crosses the agent surface already on the data
 * side of the trust boundary.
 *
 * Pure: no I/O, no clock, no randomness. The capture lives in `harvest.ts`.
 */

export const LAYOUT_SIGNATURE_VERSION = 1;

/**
 * Grid resolution. §6.1 of the spec asks for the COARSEST grid that still separates, because
 * coarser is more redesign-robust and smaller on disk; `benchmarks/visual/` sweeps it. 12x16 x 2
 * channels is also exactly 384 cells, which is the dimension `vec_documents` is frozen at
 * (`001-sqlite-vec.sql:10`) — noted, not depended on: S11d's storage decision is not S11a's.
 */
export const LAYOUT_GRID_X = 12;
export const LAYOUT_GRID_Y = 16;

/** `box` (each element contributes one unit of mass over its footprint) and `text` (its text length). */
export const LAYOUT_CHANNELS = 2;

/** One byte per cell — the resolution the wire form is sized for. */
export const LAYOUT_QUANT_MAX = 255;

/**
 * D5 clamp. Mirrors `MAX_REGION_PX` in `vision.ts:85` and its reasoning: a page-influenced number
 * that feeds a normalisation step is a divide-by-something-absurd unless it is bounded. 65536 CSS px
 * is ~40x the tallest real viewport and ~8x a long article, so it clamps only hostile input.
 * Deliberately NOT operator-tunable, same as its precedent.
 */
export const MAX_LAYOUT_COORD_PX = 65536;

/** A page reporting more laid-out boxes than this is truncated deterministically rather than trusted. */
export const MAX_LAYOUT_BOXES = 20000;

/** Text length is page-reported too; an absurd value would swamp the text channel's maximum. */
export const MAX_TEXT_LENGTH = 1_000_000;

const MIN_DPR = 0.25;
const MAX_DPR = 8;

/** G-S11a-3: the serialised form must stay under this, which is what makes per-page persistence affordable. */
export const MAX_SIGNATURE_BYTES = 2048;

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Characters of rendered text in this box. Length only — the characters never enter the signature. */
  textLength?: number;
}

export interface LayoutViewport {
  /** Viewport width in CSS px. */
  width: number;
  /** Viewport height in CSS px. */
  height: number;
  /** The factor converting `LayoutBox` units to CSS px. A capture already in CSS px passes 1. */
  devicePixelRatio: number;
}

export interface LayoutInput {
  boxes: LayoutBox[];
  viewport: LayoutViewport;
}

export interface LayoutSignatureOptions {
  gridX?: number;
  gridY?: number;
}

export interface LayoutSignature {
  version: typeof LAYOUT_SIGNATURE_VERSION;
  gridX: number;
  gridY: number;
  /** `gridX * gridY * LAYOUT_CHANNELS` bytes: the box channel, then the text channel, row-major. */
  cells: Uint8Array;
  /** Boxes that survived the D5 filter — 0 means a blank or failed render, which must not near-match anything. */
  boxCount: number;
  /** True when hostile or malformed geometry was clamped or dropped. Surfaced so a caller can distrust the vector further. */
  clamped: boolean;
  /**
   * Page-derived geometry is UNTRUSTED. Welded `false` from construction (like `StructuredTarget`
   * and `VisionResult`) so it is on the data side of the trust boundary before it is ever returned.
   */
  trusted: false;
}

function finitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function clampCoord(n: number): number {
  if (n > MAX_LAYOUT_COORD_PX) return MAX_LAYOUT_COORD_PX;
  if (n < -MAX_LAYOUT_COORD_PX) return -MAX_LAYOUT_COORD_PX;
  return n;
}

function normalizeDpr(dpr: number): number {
  if (!finitePositive(dpr)) return 1;
  return Math.min(MAX_DPR, Math.max(MIN_DPR, dpr));
}

interface CleanBox { x: number; y: number; w: number; h: number; t: number }

/** D5: drop what cannot be geometry, clamp what can be hostile. Reports whether anything had to be touched. */
function sanitize(boxes: readonly LayoutBox[], dpr: number): { kept: CleanBox[]; clamped: boolean } {
  let clamped = false;
  let src = boxes;
  if (src.length > MAX_LAYOUT_BOXES) {
    src = src.slice(0, MAX_LAYOUT_BOXES);
    clamped = true;
  }
  const kept: CleanBox[] = [];
  for (const b of src) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.width) || !Number.isFinite(b.height)) {
      clamped = true;
      continue;
    }
    if (b.width <= 0 || b.height <= 0) continue; // not rendered — not a clamp, just not layout
    const x = clampCoord(b.x / dpr);
    const y = clampCoord(b.y / dpr);
    const w = Math.min(b.width / dpr, MAX_LAYOUT_COORD_PX);
    const h = Math.min(b.height / dpr, MAX_LAYOUT_COORD_PX);
    if (w !== b.width / dpr || h !== b.height / dpr || x !== b.x / dpr || y !== b.y / dpr) clamped = true;
    const rawText = b.textLength ?? 0;
    let t = Number.isFinite(rawText) && rawText > 0 ? rawText : 0;
    if (t > MAX_TEXT_LENGTH) {
      t = MAX_TEXT_LENGTH;
      clamped = true;
    }
    kept.push({ x, y, w, h, t });
  }
  return { kept, clamped };
}

/**
 * Normalise → accumulate → max-normalise → quantise.
 *
 * Each box spreads a FIXED mass over its footprint rather than contributing its area, so a
 * full-page background wrapper contributes one unit diluted across the whole grid while a hundred
 * small cards contribute a hundred units concentrated where they sit. Contributing raw area would
 * let one `<body>`-sized box wash out every real signal on the page.
 */
export function computeLayoutSignature(input: LayoutInput, opts: LayoutSignatureOptions = {}): LayoutSignature {
  const gridX = opts.gridX ?? LAYOUT_GRID_X;
  const gridY = opts.gridY ?? LAYOUT_GRID_Y;
  const cellCount = gridX * gridY;
  const dpr = normalizeDpr(input.viewport?.devicePixelRatio ?? 1);
  const { kept, clamped } = sanitize(input.boxes ?? [], dpr);

  const acc = new Float64Array(cellCount * LAYOUT_CHANNELS);
  const cells = new Uint8Array(cellCount * LAYOUT_CHANNELS);
  const base: LayoutSignature = {
    version: LAYOUT_SIGNATURE_VERSION,
    gridX,
    gridY,
    cells,
    boxCount: kept.length,
    clamped,
    trusted: false,
  };
  if (kept.length === 0) return base;

  let maxRight = 0;
  let maxBottom = 0;
  for (const b of kept) {
    if (b.x + b.w > maxRight) maxRight = b.x + b.w;
    if (b.y + b.h > maxBottom) maxBottom = b.y + b.h;
  }
  const vw = finitePositive(input.viewport?.width) ? Math.min(input.viewport.width, MAX_LAYOUT_COORD_PX) : 0;
  const vh = finitePositive(input.viewport?.height) ? Math.min(input.viewport.height, MAX_LAYOUT_COORD_PX) : 0;
  // The page's own extent, floored by the viewport: content that overflows horizontally must not
  // fall off the grid, and a page shorter than the viewport must not be stretched to fill it.
  const extentX = Math.max(vw, maxRight, 1);
  const extentY = Math.max(vh, maxBottom, 1);

  for (const b of kept) {
    const u0 = Math.max(0, Math.min(1, b.x / extentX));
    const u1 = Math.max(0, Math.min(1, (b.x + b.w) / extentX));
    const v0 = Math.max(0, Math.min(1, b.y / extentY));
    const v1 = Math.max(0, Math.min(1, (b.y + b.h) / extentY));
    const area = (u1 - u0) * (v1 - v0);
    if (!(area > 0)) continue; // entirely off-page after clamping

    const i0 = Math.min(gridX - 1, Math.floor(u0 * gridX));
    const i1 = Math.min(gridX - 1, Math.ceil(u1 * gridX) - 1);
    const j0 = Math.min(gridY - 1, Math.floor(v0 * gridY));
    const j1 = Math.min(gridY - 1, Math.ceil(v1 * gridY) - 1);
    for (let j = j0; j <= j1; j++) {
      const cy0 = j / gridY;
      const cy1 = (j + 1) / gridY;
      const oy = Math.min(v1, cy1) - Math.max(v0, cy0);
      if (!(oy > 0)) continue;
      for (let i = i0; i <= i1; i++) {
        const cx0 = i / gridX;
        const cx1 = (i + 1) / gridX;
        const ox = Math.min(u1, cx1) - Math.max(u0, cx0);
        if (!(ox > 0)) continue;
        const share = (ox * oy) / area;
        const idx = j * gridX + i;
        acc[idx] += share;
        acc[cellCount + idx] += share * b.t;
      }
    }
  }

  // Per-channel MAX normalisation, not sum: at 192 cells a sum-normalised profile would land every
  // cell in the bottom 1% of the byte range and quantise away the whole signal.
  for (let c = 0; c < LAYOUT_CHANNELS; c++) {
    const off = c * cellCount;
    let max = 0;
    for (let k = 0; k < cellCount; k++) if (acc[off + k] > max) max = acc[off + k];
    if (!(max > 0)) continue;
    for (let k = 0; k < cellCount; k++) cells[off + k] = Math.round((acc[off + k] / max) * LAYOUT_QUANT_MAX);
  }
  return base;
}

/**
 * Normalised L1 over each channel, averaged. `sum|a-b| / (sum a + sum b)` rather than plain L1
 * so the result is in [0,1] for ANY pair — including a blank render against a real one, which
 * comes out at exactly 1 instead of the 0.5 a plain L1 would report. Identical → 0; two blanks → 0.
 * O(1) in page size: the vector length is fixed by the grid.
 */
export function layoutDistance(a: LayoutSignature, b: LayoutSignature): number {
  if (a.gridX !== b.gridX || a.gridY !== b.gridY || a.cells.length !== b.cells.length) return 1;
  const cellCount = a.gridX * a.gridY;
  let total = 0;
  for (let c = 0; c < LAYOUT_CHANNELS; c++) {
    const off = c * cellCount;
    let diff = 0;
    let mass = 0;
    for (let k = 0; k < cellCount; k++) {
      const x = a.cells[off + k];
      const y = b.cells[off + k];
      diff += Math.abs(x - y);
      mass += x + y;
    }
    total += mass > 0 ? diff / mass : 0;
  }
  return total / LAYOUT_CHANNELS;
}

/** Wire form: `lsig<version>:<gridX>x<gridY>:<boxCount>:<clamped>:<base64 cells>`. */
export function serializeLayoutSignature(sig: LayoutSignature): string {
  const payload = Buffer.from(sig.cells).toString('base64');
  return `lsig${sig.version}:${sig.gridX}x${sig.gridY}:${sig.boxCount}:${sig.clamped ? 1 : 0}:${payload}`;
}

const MAX_GRID_DIM = 64;

/** A stored signature is untrusted input on the way back in: malformed → `null`, never a throw, never a partial. */
export function deserializeLayoutSignature(wire: string): LayoutSignature | null {
  if (typeof wire !== 'string') return null;
  const parts = wire.split(':');
  if (parts.length !== 5) return null;
  const [tag, grid, countRaw, clampedRaw, payload] = parts;
  if (tag !== `lsig${LAYOUT_SIGNATURE_VERSION}`) return null;
  const dims = grid.split('x');
  if (dims.length !== 2) return null;
  const gridX = Number(dims[0]);
  const gridY = Number(dims[1]);
  if (!Number.isInteger(gridX) || !Number.isInteger(gridY)) return null;
  if (gridX < 1 || gridY < 1 || gridX > MAX_GRID_DIM || gridY > MAX_GRID_DIM) return null;
  const boxCount = Number(countRaw);
  if (!Number.isInteger(boxCount) || boxCount < 0) return null;
  if (clampedRaw !== '0' && clampedRaw !== '1') return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length !== gridX * gridY * LAYOUT_CHANNELS) return null;
  return {
    version: LAYOUT_SIGNATURE_VERSION,
    gridX,
    gridY,
    cells: new Uint8Array(bytes),
    boxCount,
    clamped: clampedRaw === '1',
    trusted: false,
  };
}
