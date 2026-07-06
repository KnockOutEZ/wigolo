/**
 * Pure element-child-index path resolution — the overlay↔resolver bridge (P2).
 * The isolated-world overlay serializes a picked element as element-child indices from
 * documentElement (text/comment nodes skipped). Main resolves that path against a fresh
 * AX⋈DOM `DomNode` tree (the same DOM.getDocument the snapshotter fetches) to a live
 * backendNodeId, which `buildTarget` turns into the durable StructuredTarget. Pure: a
 * plain tree walk, no CDP, no I/O — fully unit-testable and drift-safe (a stale path
 * returns null → the mark is declined, never a wrong element).
 *
 * CDP places shadow roots on `node.shadowRoots` and frame content on `node.contentDocument`
 * — never on `node.children` — so this light-DOM walk is unaffected by shadow/frame folding
 * (the overlay's `elementPath` walks the composed light DOM via `parent.children`, giving
 * identical membership + ordering for a light-DOM pick).
 */
import type { DomNode } from '../perception/snapshot.js';

/** Element nodes only (nodeType 1). CDP DOM.Node always carries nodeType, so a nodeName
 * heuristic (which would misclassify a DOCTYPE — nodeName 'html', no leading '#') is not needed. */
function isElement(n: DomNode): boolean {
  return n.nodeType === 1;
}

function elementChildren(n: DomNode): DomNode[] {
  return (n.children ?? []).filter(isElement);
}

/**
 * Walk `path` (element-child indices from documentElement) to a backendNodeId.
 * `root` is the DOM.getDocument #document node; its first element child is documentElement.
 * Returns null if the root is empty or any index is out of range (the DOM drifted since the
 * pick, or the path crossed a boundary the light-DOM walk can't express).
 */
export function resolveNodePath(root: DomNode | undefined, path: number[]): number | null {
  if (!root) return null;
  const docEl = elementChildren(root)[0]; // <html>
  if (!docEl) return null;
  let cur: DomNode = docEl;
  for (const idx of path) {
    const kids = elementChildren(cur);
    const next = kids[idx];
    if (!next) return null;
    cur = next;
  }
  return typeof cur.backendNodeId === 'number' ? cur.backendNodeId : null;
}
