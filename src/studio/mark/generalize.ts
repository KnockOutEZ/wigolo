/**
 * List generalization (HANDOFF §3 generalize). A human marks ONE element in a repeating
 * structure (a product card, a table row); `generalize` finds the SIBLING set so the agent can
 * act across all of them — but ONLY as a preview the human confirms (`requires_confirmation`).
 * It NEVER acts: it returns the live snapshot refs the EXISTING 2J resolver resolves at dispatch,
 * so the previewed set is exactly the dispatched set (one shared ref list, no parallel resolver).
 *
 * Structural match (minimal — defers the rich DEPTA subtree walk): a candidate joins the set when
 * it shares the seed's a11y `role` AND its generalized ancestor-path spine within a normalized
 * segment edit-distance (≤0.3 default). Repeating siblings share the EXACT generalized spine
 * (positional indices dropped) → distance 0; the threshold tolerates a one-wrapper variation; an
 * off-pattern row (a "Sponsored" promo with extra nesting) exceeds it and is excluded.
 *
 * `applyGeometry` is the minimal geometric tiebreaker over that structural set. Both are pure: the
 * host fetches the candidate set (shared with heal) and the boxes and composes — no I/O here.
 */
import type { StructuredTarget } from './target.js';
import type { HealCandidate, HealConfidence } from './heal.js';

/**
 * Reuses heal's 4-tier union. The minimal structural+geometry version emits only `none`
 * (no repeating pattern), `medium` (a set with loosened spines or a pruned geometric outlier),
 * and `high` (an exact-spine, geometrically-regular set). `low` is RESERVED for the deferred
 * rich (DEPTA) version — do not add a test for it or remove it from the union.
 */
export type GeneralizeConfidence = HealConfidence;

export interface GeneralizeMatch {
  ref: string;
  backendNodeId: number;
  /** Normalized spine edit-distance from the seed (0 = an exact repeating sibling). */
  distance: number;
}

export interface GeneralizeStructural {
  matches: GeneralizeMatch[];
  confidence: GeneralizeConfidence;
}

export interface GenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeneralizeResult {
  /** The matched set's live snapshot refs, visually ordered — the agent passes each to studio_act ONLY after a human confirm. */
  refs: string[];
  confidence: GeneralizeConfidence;
  /** Always true: generalize is a preview READ — the agent never acts on the set without an explicit human confirm. */
  requires_confirmation: true;
}

const DEFAULT_MAX_DISTANCE = 0.3;
/** A nearest-neighbour gap this many times the set's median marks a visual outlier (a same-structured element off the list). */
const OUTLIER_GAP_FACTOR = 3;

/** Normalized segment-level Levenshtein over a '/'-joined spine. 0 = identical, 1 = fully different. */
export function segEditDistance(a: string, b: string): number {
  const x = a ? a.split('/') : [];
  const y = b ? b.split('/') : [];
  if (x.length === 0 && y.length === 0) return 0;
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = 0; i <= x.length; i++) dp[i][0] = i;
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] = x[i - 1] === y[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

/**
 * Structural pass: the candidates sharing the seed's role AND spine within `maxDistance`.
 * <2 matches → `none` (no repeating pattern — nothing to generalize, never a lone guess).
 * All matches exact-spine → `high`; any loosened (distance > 0) → `medium`.
 */
export function generalize(
  seed: StructuredTarget,
  candidates: HealCandidate[],
  opts: { maxDistance?: number } = {},
): GeneralizeStructural {
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  // An empty role is too weak to generalize on (it collides across every unnamed node) — mirror heal.
  if (!seed.role) return { matches: [], confidence: 'none' };
  const matches: GeneralizeMatch[] = [];
  for (const c of candidates) {
    if (c.target.role !== seed.role) continue;
    const distance = segEditDistance(c.target.ancestorPath, seed.ancestorPath);
    if (distance <= maxDistance) matches.push({ ref: c.ref, backendNodeId: c.target.backendNodeId, distance });
  }
  if (matches.length < 2) return { matches: [], confidence: 'none' };
  const confidence: GeneralizeConfidence = matches.every((m) => m.distance === 0) ? 'high' : 'medium';
  return { matches, confidence };
}

/**
 * Minimal geometric tiebreaker over the structural set: prune a gross visual outlier (a
 * same-structured element whose nearest-neighbour gap is far larger than the set's median — e.g. a
 * footer button matching the list's spine) and order the kept refs top-to-bottom, left-to-right.
 * Fewer than two boxed matches → no geometry signal, keep the structural set as-is (not-rendered ≠
 * off-pattern; the human confirms). A prune lowers a `high` set to `medium` (the visual
 * irregularity reduces certainty). Pure.
 */
export function applyGeometry(structural: GeneralizeStructural, boxes: Map<string, GenBox>): GeneralizeResult {
  const matches = structural.matches;
  const requires_confirmation = true as const;
  const boxed = matches.filter((m) => boxes.has(m.ref));
  if (boxed.length < 2) {
    return { refs: matches.map((m) => m.ref), confidence: structural.confidence, requires_confirmation };
  }
  const center = (m: GeneralizeMatch) => {
    const b = boxes.get(m.ref)!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const nnGap = (m: GeneralizeMatch): number => {
    const c = center(m);
    let min = Infinity;
    for (const other of boxed) {
      if (other === m) continue;
      const o = center(other);
      const d = Math.hypot(c.x - o.x, c.y - o.y);
      if (d < min) min = d;
    }
    return min;
  };
  const sortedGaps = boxed.map(nnGap).sort((p, q) => p - q);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const kept = boxed.filter((m) => nnGap(m) <= OUTLIER_GAP_FACTOR * median);
  kept.sort((p, q) => {
    const a = center(p), b = center(q);
    return a.y - b.y || a.x - b.x;
  });
  const pruned = boxed.length - kept.length;
  // Matches without a box can't be visually placed — keep them (not-rendered ≠ off-pattern), appended.
  const unboxed = matches.filter((m) => !boxes.has(m.ref));
  const refs = [...kept, ...unboxed].map((m) => m.ref);
  const confidence: GeneralizeConfidence =
    pruned > 0 && structural.confidence === 'high' ? 'medium' : structural.confidence;
  return { refs, confidence, requires_confirmation };
}
