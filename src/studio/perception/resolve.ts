import type { PageSnapshot, PerceptionCdp } from './snapshot.js';
import type { FieldSemantics } from '../credential.js';

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
 * Occlusion: after the box centre is computed, a hit-test (`DOM.getNodeForLocation`)
 * confirms the topmost node at that point is the target or a descendant of it; if a
 * different node (overlay / modal / cookie banner that appeared between observe and
 * act) is on top, the click is refused as `element_occluded` — same re-observe path
 * as a stale ref. The descendant walk uses the snapshot's host-side `domParent` map
 * (crosses shadow roots).
 *
 * COORDINATE SPACES (measured, not assumed — diagnosed before Phase 3): `getBoxModel`
 * and the `Input.dispatchMouseEvent` the channel dispatches into are VIEWPORT-relative,
 * but `DOM.getNodeForLocation` is DOCUMENT-relative. So the returned `center` is the
 * viewport point (dispatch verbatim, correct under scroll), while the hit-test queries
 * `center + scrollOffset`. Skipping the shift silently breaks occlusion on any scrolled
 * page — which is exactly the Phase-3 list-scrolling path.
 */

export interface ResolvedTarget {
  /** The live backend node id (internal handle — never surfaced to the agent). */
  backendNodeId: number;
  /** Click point in the page coordinate space the input channel dispatches into. */
  center: { x: number; y: number };
  /**
   * The resolved element's a11y role + accessible name (page-derived, UNTRUSTED). Surfaced so the
   * Phase-6c risk gate can read them as the SOFT signal without a second snapshot fetch. Optional
   * on the type so callers/fakes that don't need them stay valid; the real resolver always sets them.
   */
  role?: string;
  name?: string;
  /**
   * The resolved element's TRUE DOM input semantics (tag + credential-relevant attrs), read from the
   * privileged pierced snapshot — the 5a credential guard's HARD signal, NEVER the spoofable role/name.
   * Optional so callers/fakes that don't populate the snapshot's domByRef stay valid.
   */
  semantics?: FieldSemantics;
  /** Whether the CURRENT page has any credential field present (host-read) — the 5a/5b credential-context signal. */
  pageHasCredentialField?: boolean;
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

/**
 * The page's current scroll offset in CSS px (DPR-safe — `cssVisualViewport` is the
 * explicitly-CSS-px field; the deprecated `visualViewport` is device px and would re-break
 * DPR≠1). `DOM.getNodeForLocation` takes DOCUMENT coordinates, so the viewport-relative
 * click centre is shifted by this for the hit-test. Returns `null` if the read FAILS — the
 * caller then fails CLOSED rather than hit-testing blind at viewport coords on a page that
 * might be scrolled (which would falsely pass an occluded target). A successful read with a
 * zero offset (the scrollY=0 case) returns {0,0}, not null.
 */
async function scrollOffset(cdp: PerceptionCdp): Promise<{ x: number; y: number } | null> {
  try {
    const m = (await cdp.send('Page.getLayoutMetrics')) as { cssVisualViewport?: { pageX?: number; pageY?: number } };
    return { x: m?.cssVisualViewport?.pageX ?? 0, y: m?.cssVisualViewport?.pageY ?? 0 };
  } catch {
    return null;
  }
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

    // Occlusion hit-test. getNodeForLocation is DOCUMENT-relative (getBoxModel/dispatch are
    // viewport-relative), so query the click centre shifted by the scroll offset — else the
    // hit-test lands at the wrong document point on a scrolled page. If the scroll offset is
    // unreadable, FAIL CLOSED (treat as occluded → re-observe): hit-testing blind at viewport
    // coords on a possibly-scrolled page could falsely pass an occluded target. A topmost node
    // that is neither the target nor a descendant means something is covering it.
    const scroll = await scrollOffset(deps.cdp);
    if (!scroll) return { error: 'element_occluded' };
    const hit = (await deps.cdp.send('DOM.getNodeForLocation', {
      x: Math.round(center.x + scroll.x),
      y: Math.round(center.y + scroll.y),
      includeUserAgentShadowDOM: false,
    })) as { backendNodeId?: number };
    const top = hit?.backendNodeId;
    if (top != null && !isTargetOrDescendant(top, backendNodeId, snap.domParent)) {
      return { error: 'element_occluded' };
    }
    // Surface the page-derived role/name (untrusted) alongside the coords — the 6c risk gate's soft signal —
    // plus the target's TRUE pierced-DOM semantics + the page credential-context flag for the 5a hard guard.
    return { backendNodeId, center, role: el.role, name: el.name, semantics: snap.domByRef?.get(ref), pageHasCredentialField: snap.hasCredentialField };
  };
}
