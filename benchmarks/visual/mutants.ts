/**
 * The four S11a inversion mutants, spelled out once so the runner and the probe tests cannot drift.
 *
 * Spec `2026-08-10-s11-visual-v1-spec.md:475-478`, verbatim:
 *
 *   "Inversion probes for S11a (must be run, each must red): return a constant vector (G-S11a-1 must
 *    red); skip the DPR/viewport normalisation (the cross-viewport clause must red); replace the
 *    one-shot harvest with the per-node loop (G-S11a-2 must red); remove the D5 clamp and feed a
 *    hostile 10^9-px box (the clamp test must red)."
 *
 * Three of the four are expressed WITHOUT editing `src/`, by exploiting an exact arithmetic identity
 * in each case (documented per mutant). That matters for more than tidiness: a mutant that only exists
 * as a temporary edit can be run once and never again, which is the same as not having it. Each
 * identity was cross-checked against the corresponding live mutation of `src/studio/layout/signature.ts`
 * and reproduces it exactly; the live edits were reverted and the shipped tree is unchanged.
 *
 * The fourth (the per-node harvest) is not a signer at all — it lives in the probe test beside the
 * counting transport it is measured on.
 */
import {
  computeLayoutSignature,
  LAYOUT_CHANNELS,
  LAYOUT_GRID_X,
  LAYOUT_GRID_Y,
  MAX_LAYOUT_COORD_PX,
  type LayoutInput,
  type LayoutSignature,
} from '../../src/studio/layout/signature.js';
import { signerAt, DESKTOP_WIDTH, type Signer } from './score.js';

/**
 * MUTANT 1 — a signature that ignores its input entirely.
 *
 * The spec cites this shape as the reason G-S11a-1 has an outside signal at all: "the gate cannot be
 * satisfied by a signature that returns a constant, because a constant collapses both bands."
 */
export function constantSigner(gridX = LAYOUT_GRID_X, gridY = LAYOUT_GRID_Y): Signer {
  const constant = new Uint8Array(gridX * gridY * LAYOUT_CHANNELS).fill(64);
  return () => ({ version: 1, gridX, gridY, cells: constant, boxCount: 1, clamped: false, trusted: false });
}

/**
 * MUTANT 2a — the DPR division removed.
 *
 * `devicePixelRatio` is used for exactly one thing: dividing every coordinate in `sanitize`. Reporting
 * a ratio of 1 on device-px input is therefore arithmetically identical to deleting that division.
 * Equivalent to a live `const dpr = 1`, measured: same numbers on every gate.
 */
export function noDprSigner(gridX = LAYOUT_GRID_X, gridY = LAYOUT_GRID_Y): Signer {
  const s = signerAt(gridX, gridY);
  return (input) => s({ boxes: input.boxes, viewport: { ...input.viewport, devicePixelRatio: 1 } });
}

/**
 * MUTANT 2b — the viewport-WIDTH normalisation removed.
 *
 * "Not normalised by viewport width" means every render is placed on ONE fixed reference frame instead
 * of its own. `extentX` is `max(viewportWidth, contentRight, 1)` and no corpus page overflows 1280px,
 * so pinning the reported width to the desktop width makes `extentX` that constant for every render.
 * Equivalent to a live `const extentX = 1280`, measured: the same clause-2 percentage at every width.
 *
 * Deliberately leaves the Y axis alone. D3 names the viewport WIDTH, and clause 2 varies only the
 * width, so a mutation that also flattened Y would red the clause for a reason the clause is not about.
 */
export function noWidthNormSigner(gridX = LAYOUT_GRID_X, gridY = LAYOUT_GRID_Y): Signer {
  const s = signerAt(gridX, gridY);
  return (input) => s({ boxes: input.boxes, viewport: { ...input.viewport, width: DESKTOP_WIDTH } });
}

/**
 * MUTANT 4 — the D5 clamp removed.
 *
 * Everything downstream of `sanitize` is scale-invariant, so signing an input scaled down by K is
 * exactly what a build with no clamp would produce on the original. Two preconditions, both checkable
 * and both asserted by the probe rather than assumed:
 *
 *   1. `maxCoord / K < MAX_LAYOUT_COORD_PX`, or the real clamp fires anyway and nothing was removed;
 *   2. `extent / K > 1`, or the pipeline's hard 1-px extent floor — not the geometry — decides the
 *      normalisation, and the surrogate models nothing. This one is easy to trip: the corpus renders
 *      at 1280px, and at K = 2^20 their extent lands at 0.0012.
 *
 * K is a power of two so the scaling is EXACT in binary floating point; the surrogate is bit-identical
 * to a live `clampCoord = identity` build, not approximately identical to it.
 */
export const UNCLAMP_SCALE = 2 ** 20;

export function scaleInput(input: LayoutInput, k: number): LayoutInput {
  return {
    boxes: input.boxes.map((b) => ({
      x: b.x / k, y: b.y / k, width: b.width / k, height: b.height / k, textLength: b.textLength,
    })),
    viewport: {
      width: input.viewport.width / k,
      height: input.viewport.height / k,
      devicePixelRatio: input.viewport.devicePixelRatio,
    },
  };
}

/** True when `scaleInput(input, k)` is a faithful no-clamp surrogate for `input`. */
export function unclampWindowHolds(maxCoord: number, extent: number, k: number): boolean {
  return maxCoord / k < MAX_LAYOUT_COORD_PX && extent / k > 1;
}

export function unclampedSignature(input: LayoutInput, k = UNCLAMP_SCALE): LayoutSignature {
  return computeLayoutSignature(scaleInput(input, k));
}
