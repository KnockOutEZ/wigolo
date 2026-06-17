/**
 * Accessibility-tree page snapshot for the agent's `studio_observe`. Joins the
 * composed CDP accessibility tree (`Accessibility.getFullAXTree`) to the pierced
 * DOM (`DOM.getDocument({pierce:true})`) — the PRIVILEGED path, so open, nested,
 * AND closed shadow roots are surfaced and fingerprinted from real attributes (a
 * page-script DOM read could not pierce closed roots and would degrade them).
 *
 * Refs come from `id.ts` — a pure function of the live state, no counter/registry,
 * so a cold service yields the same handles as a warm one. The snapshotter holds NO
 * per-session identity state. Kept async + yielding so a heavy page (the 2D spike
 * measured ~900 interactive elements ≈ 13.5K tokens) does not block the
 * screencast/input loop during an observe.
 */
import { countTokens } from '../../search/tokens.js';
import { assignRefs, computeFingerprint, hash } from './id.js';

/** Interactive a11y roles — the actionable surface (matches the 2D spike's filter so its numbers transfer). */
const INTERACTIVE = new Set([
  'button', 'textbox', 'searchbox', 'link', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'option',
]);

interface AxNode {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
}

interface DomNode {
  backendNodeId?: number;
  localName?: string;
  nodeName?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  shadowRootType?: string;
  contentDocument?: DomNode;
}

interface DomInfo {
  localName: string;
  attrs: Record<string, string>;
  parent: number | null;
  index: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  /** Set when the ref was positionally tiebroken (identical-sibling run) — 2J must not silently act on it. */
  confidence?: 'low';
}

export interface PageSnapshot {
  /** Content hash of `elements` — the base id a diff is taken against. Pure (no counter), so cold == warm. */
  id: string;
  elements: SnapshotElement[];
  tokenCount: number;
  /** Token budget exceeded → spill at the transport layer (2F). Does NOT affect `elements` (diff stays budget-independent). */
  overBudget: boolean;
  /** DOM depth cap hit → some deep content omitted. A partial-snapshot signal (fail-loud — never a silent drop), even for the attack guard. */
  domTruncated: boolean;
  /** ref → current backendDOMNodeId, host-side ONLY (never serialized to the agent). 2J resolves coords through this. */
  refMap: Map<string, number>;
  /** ref → fingerprint group, host-side ONLY, for low-confidence elements. The diff folds positional drift of an identical-sibling run into low-confidence churn (not phantom add/remove) by matching groups. */
  groupByRef: Map<string, string>;
}

export interface PerceptionCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function attrsToObj(a: string[] = []): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
}

/** Defense-in-depth: bound the recursion so a malformed/hostile tree can't overflow the host. An honest DOM.getDocument tree is a shallow spanning tree, far below this. */
const MAX_DOM_DEPTH = 2000;

/** Flatten DOM.getDocument(pierce:true) into backendNodeId → DomInfo, crossing shadow roots + same-target frames. Reports whether the depth cap dropped content (fail-loud — no silent truncation). */
function flattenDom(root: DomNode | undefined): { map: Map<number, DomInfo>; truncated: boolean } {
  const map = new Map<number, DomInfo>();
  let truncated = false;
  if (!root) return { map, truncated };
  const walk = (node: DomNode, parent: number | null, index: number, depth: number): void => {
    if (depth > MAX_DOM_DEPTH) { truncated = true; return; } // bounded; surface a partial signal, never silently drop
    const be = node.backendNodeId;
    if (be != null) map.set(be, { localName: node.localName || node.nodeName || '#', attrs: attrsToObj(node.attributes), parent, index });
    let i = 0;
    for (const c of node.children ?? []) walk(c, be ?? parent, i++, depth + 1);
    for (const sr of node.shadowRoots ?? []) walk(sr, be ?? parent, i++, depth + 1); // open AND closed — CDP is privileged
    if (node.contentDocument) walk(node.contentDocument, be ?? parent, i++, depth + 1);
  };
  walk(root, null, 0, 0);
  return { map, truncated };
}

function pathSig(map: Map<number, DomInfo>, be: number): string {
  const seg: string[] = [];
  let cur: number | null = be;
  let guard = 0;
  while (cur != null && guard++ < 200) {
    const d = map.get(cur);
    if (!d) break;
    seg.unshift(`${d.localName}[${d.index}]`);
    cur = d.parent;
  }
  return seg.join('/');
}

/** Pure: join the AX tree to the pierced DOM, assign refs, measure tokens. No I/O, no state. */
export function buildSnapshot(axNodes: AxNode[], domRoot: DomNode | undefined, opts: { tokenBudget: number }): PageSnapshot {
  const { map: dom, truncated: domTruncated } = flattenDom(domRoot);
  const records: Array<{ role: string; name: string; be: number | undefined; fingerprint: string; positionPath: string }> = [];
  for (const n of axNodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    if (!role || !INTERACTIVE.has(role)) continue;
    const be = n.backendDOMNodeId;
    const d = be != null ? dom.get(be) : undefined;
    const name = n.name?.value ?? '';
    records.push({
      role,
      name,
      be,
      fingerprint: computeFingerprint({ role, name, attrs: d?.attrs }),
      positionPath: be != null ? pathSig(dom, be) : '',
    });
  }
  const refs = assignRefs(records);
  const elements: SnapshotElement[] = [];
  const refMap = new Map<string, number>();
  const groupByRef = new Map<string, string>();
  records.forEach((r, i) => {
    const { ref, confidence } = refs[i];
    elements.push(confidence ? { ref, role: r.role, name: r.name, confidence } : { ref, role: r.role, name: r.name });
    if (r.be != null) refMap.set(ref, r.be);
    // Low-confidence (identical-sibling) refs share a fingerprint group, so the diff
    // can recognize their positional drift as churn rather than phantom add/remove.
    if (confidence === 'low') groupByRef.set(ref, 'g' + hash(r.fingerprint));
  });
  const tokenCount = countTokens(JSON.stringify(elements));
  const id = 's' + hash(JSON.stringify(elements));
  return { id, elements, tokenCount, overBudget: tokenCount > opts.tokenBudget, domTruncated, refMap, groupByRef };
}

export class PageSnapshotter {
  private readonly tokenBudget: number;

  constructor(opts: { tokenBudget: number }) {
    this.tokenBudget = opts.tokenBudget;
  }

  /** Observe the current page. Async + yields once to the event loop before the CPU join so an observe never freezes the live session. */
  async snapshot(cdp: PerceptionCdp): Promise<PageSnapshot> {
    const ax = (await cdp.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
    await new Promise<void>((resolve) => setImmediate(resolve)); // let the screencast/input loop breathe before the join
    return buildSnapshot(ax.nodes ?? [], doc.root, { tokenBudget: this.tokenBudget });
  }
}
