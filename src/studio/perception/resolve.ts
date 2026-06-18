import type { PageSnapshot, PerceptionCdp } from './snapshot.js';

/**
 * Resolve a snapshot `ref` to a clickable coordinate AT ACTION TIME — never cached.
 *
 * Each call takes a FRESH snapshot and looks the ref up in it, so a re-rendered or
 * moved element resolves to its CURRENT box (clicking a coordinate captured in an
 * earlier snapshot would click where the element *was*). A ref absent from the
 * current snapshot fails as `element_no_longer_present` and is NEVER silently
 * resolved to a different element; a low-confidence (identical-sibling) ref is
 * refused as `element_low_confidence` so 2J asks / re-observes rather than guessing
 * which of N look-alikes to act on.
 *
 * Occlusion: after the box centre is computed, a hit-test (`DOM.getNodeForLocation`,
 * the SAME coordinate space the click dispatches into) confirms the topmost node at
 * that point is the target or a descendant of it; if a different node (overlay /
 * modal / cookie banner that appeared between observe and act) is on top, the click
 * is refused as `element_occluded` — same re-observe path as a stale ref. The
 * descendant walk uses the snapshot's host-side `domParent` map (crosses shadow roots).
 */

export interface ResolvedTarget {
  /** The live backend node id (internal handle — never surfaced to the agent). */
  backendNodeId: number;
  /** Click point in the page coordinate space the input channel dispatches into. */
  center: { x: number; y: number };
}

export type ResolveErrorReason =
  | 'element_no_longer_present'
  | 'element_low_confidence'
  | 'element_not_visible'
  | 'element_occluded';

export type ResolveResult = ResolvedTarget | { error: ResolveErrorReason };

export interface ResolveDeps {
  /** Take a LIVE snapshot (the host binds this to the session CDP). Called fresh on every resolve. */
  snapshot: () => Promise<PageSnapshot>;
  cdp: PerceptionCdp;
}

export function isResolveError(r: ResolveResult): r is { error: ResolveErrorReason } {
  return typeof (r as { error?: string }).error === 'string';
}

/** content quad = [x1,y1, x2,y2, x3,y3, x4,y4]; centre = midpoint of opposite corners. */
function quadCenter(q: number[]): { x: number; y: number } {
  return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
}

/** Walk UP from `node` via parent links; true if `target` is `node` or one of its ancestors. */
function isTargetOrDescendant(node: number, target: number, parents: Map<number, number | null>): boolean {
  let cur: number | null = node;
  let guard = 0;
  while (cur != null && guard++ < 4000) {
    if (cur === target) return true;
    cur = parents.get(cur) ?? null;
  }
  return false;
}

export function createResolver(deps: ResolveDeps): (ref: string) => Promise<ResolveResult> {
  return async (ref: string): Promise<ResolveResult> => {
    const snap = await deps.snapshot(); // LIVE — fresh each call, never cached coordinates
    const el = snap.elements.find((e) => e.ref === ref);
    if (!el) return { error: 'element_no_longer_present' }; // gone → never resolve to a different element
    if (el.confidence === 'low') return { error: 'element_low_confidence' }; // identical-sibling → ask, don't guess
    const backendNodeId = snap.refMap.get(ref);
    if (backendNodeId == null) return { error: 'element_no_longer_present' };

    await deps.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {}); // bring on-screen first
    const boxRes = (await deps.cdp.send('DOM.getBoxModel', { backendNodeId })) as { model?: { content?: number[] } };
    const content = boxRes?.model?.content;
    if (!content || content.length < 8) return { error: 'element_not_visible' }; // no box → not on-screen / not boxable
    const center = quadCenter(content);

    // Occlusion hit-test in the SAME coordinate space as the dispatch. A topmost node
    // that is neither the target nor a descendant means something is covering it.
    const hit = (await deps.cdp.send('DOM.getNodeForLocation', {
      x: Math.round(center.x),
      y: Math.round(center.y),
      includeUserAgentShadowDOM: false,
    })) as { backendNodeId?: number };
    const top = hit?.backendNodeId;
    if (top != null && !isTargetOrDescendant(top, backendNodeId, snap.domParent)) {
      return { error: 'element_occluded' };
    }
    return { backendNodeId, center };
  };
}
