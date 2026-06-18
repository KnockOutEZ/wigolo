/**
 * A structured, durable target for a human-marked element (HANDOFF §3 resolver). Unlike a
 * snapshot `ref` (which is keyed to one observe), a structured target carries the locators
 * the heal cascade (3b) re-resolves through after DOM drift, and the ancestor signature the
 * list generalizer (3d) matches siblings against:
 *  - `role` + `name` — the a11y identity (heal tier 2),
 *  - `fingerprint` — role+name+stable-attr subset via the perception layer (heal tier 1, the
 *    same hash a snapshot ref is built from, so a marked element ties to its observed ref),
 *  - `ancestorPath` — the GENERALIZED tag chain with positional indices dropped (heal tier 3
 *    + the spine list-generalization matches on),
 *  - `attrs` — the FULL attribute set (multi-attribute fingerprint) for heal disambiguation.
 *
 * Built from the privileged AX⋈DOM data (the same `Accessibility.getFullAXTree` +
 * `DOM.getDocument({pierce})` the snapshotter uses), so closed-shadow marks are not degraded.
 * Pure: no I/O, no state.
 */
import { computeFingerprint } from '../perception/id.js';
import { flattenDom, type AxNode, type DomNode, type DomInfo } from '../perception/snapshot.js';

export interface StructuredTarget {
  /** Live backend node id at mark time (host-side handle; heal re-resolves it after drift). */
  backendNodeId: number;
  role: string;
  name: string;
  /**
   * The descriptive fields (`role`/`name`/`attrs`) are PAGE-DERIVED — an element's accessible
   * name/attributes are page-controlled and may carry injected instructions. Welded `false`
   * from construction (like the 2G vision channel) so it crosses the agent surface already on
   * the data side of the trust boundary; Phase 6 hardens an already-tagged channel.
   */
  trusted: false;
  /** role+name+stable-attr subset (id.ts) — the primary locator, shared with the snapshot ref hash. */
  fingerprint: string;
  /** Generalized ancestor tag chain, positional indices dropped — heal tier 3 + the generalization spine. */
  ancestorPath: string;
  /** Full attribute set — the multi-attribute fingerprint for heal disambiguation. */
  attrs: Record<string, string>;
}

/** The ancestor tag chain root→node, NO positional indices — so it matches across identical list siblings. */
function generalizedPath(map: Map<number, DomInfo>, be: number): string {
  const seg: string[] = [];
  let cur: number | null = be;
  let guard = 0;
  while (cur != null && guard++ < 200) {
    const d = map.get(cur);
    if (!d) break;
    seg.unshift(d.localName);
    cur = d.parent;
  }
  return seg.join('/');
}

/** AX backendDOMNodeId → {role, name}, first occurrence wins (matches the prior per-node `find`). */
export function indexAxByBackendNode(axNodes: AxNode[]): Map<number, { role: string; name: string }> {
  const m = new Map<number, { role: string; name: string }>();
  for (const n of axNodes) {
    if (n.ignored || n.backendDOMNodeId == null || m.has(n.backendDOMNodeId)) continue;
    m.set(n.backendDOMNodeId, { role: n.role?.value ?? '', name: n.name?.value ?? '' });
  }
  return m;
}

/**
 * Build a target from a PRE-FLATTENED DOM map + AX index. A batch (e.g. the heal candidate set)
 * flattens the DOM + indexes the AX tree ONCE and calls this per node — O(N) total instead of the
 * O(K·N) that calling `buildTarget` K times would cost (it re-flattens the whole DOM each call).
 */
export function buildTargetFromFlat(
  map: Map<number, DomInfo>,
  axByBe: Map<number, { role: string; name: string }>,
  backendNodeId: number,
): StructuredTarget | null {
  const info = map.get(backendNodeId);
  if (!info) return null; // node not in the live DOM → no target, never a guess
  const ax = axByBe.get(backendNodeId);
  const role = ax?.role ?? '';
  const name = ax?.name ?? '';
  return {
    backendNodeId,
    role,
    name,
    trusted: false, // page-derived descriptive content — untrusted from the start
    fingerprint: computeFingerprint({ role, name, attrs: info.attrs }),
    ancestorPath: generalizedPath(map, backendNodeId),
    attrs: info.attrs,
  };
}

/** Build a structured target for `backendNodeId` from the privileged AX⋈DOM data. Null if the node is absent (never a wrong target). */
export function buildTarget(axNodes: AxNode[], domRoot: DomNode | undefined, backendNodeId: number): StructuredTarget | null {
  return buildTargetFromFlat(flattenDom(domRoot).map, indexAxByBackendNode(axNodes), backendNodeId);
}
