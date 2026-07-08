import { neutralizeMarkers } from '../security/untrusted.js';

/**
 * P6 F1 — grab-all core. Turn a marked repeating pattern's generalized match cluster into structured
 * rows (columns inferred from the shared sub-structure), optionally following same-origin Document-class
 * pagination within the SSRF fence, persisted as a `type:'extraction'` artifact.
 *
 * Pure/injectable: the host (Electron main, over the live DOM) supplies the real deps; this module has
 * no Electron / native dependency and unit-tests standalone. Rows are UNTRUSTED page content →
 * neutralize-before-fence here (the renderer neutralizes again independently — dual sink).
 */

/** Minimal CDP DOM.Node shape we need for structural row inference (no native, no Electron). */
export interface MatchSubtree {
  nodeType: number; // 1 = element, 3 = text
  nodeName: string;
  nodeValue?: string;
  children?: MatchSubtree[];
}

interface LeafCell {
  path: string;
  text: string;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Direct non-whitespace text of an element (immediate text-node children only). */
function directText(node: MatchSubtree): string {
  return collapse(
    (node.children ?? [])
      .filter((c) => c.nodeType === 3)
      .map((c) => c.nodeValue ?? '')
      .join(' '),
  );
}

/** All text under a node (for the degrade path). */
function innerText(node: MatchSubtree): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  return collapse((node.children ?? []).map(innerText).join(' '));
}

/** Leaf text cells keyed by generalized tag-chain (no positional indices) from the match root. */
function leafCells(root: MatchSubtree): LeafCell[] {
  const out: LeafCell[] = [];
  const walk = (node: MatchSubtree, chain: string[]): void => {
    if (node.nodeType !== 1) return;
    const here = [...chain, node.nodeName.toLowerCase()];
    const text = directText(node);
    if (text) out.push({ path: here.join('>'), text });
    for (const child of node.children ?? []) walk(child, here);
  };
  for (const child of root.children ?? []) walk(child, []);
  return out;
}

export interface InferredRows {
  columns: string[];
  rows: Record<string, string>[];
}

/** Derive structured rows from a set of matched element subtrees. See plan §F1 for the algorithm. */
export function inferRows(matches: MatchSubtree[]): InferredRows {
  if (matches.length === 0) return { columns: [], rows: [] };
  const perMatch = matches.map(leafCells);
  // count path frequency across matches (a path counts once per match even if repeated within it)
  const freq = new Map<string, number>();
  const order: string[] = [];
  for (const cells of perMatch) {
    const seen = new Set<string>();
    for (const c of cells) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      if (!freq.has(c.path)) order.push(c.path);
      freq.set(c.path, (freq.get(c.path) ?? 0) + 1);
    }
  }
  // Strict majority (> half): a stable column must appear in MOST matches. For n=2 this requires both
  // (a path in only one of two is not a shared column → the pair degrades to a single text column).
  const majority = Math.floor(matches.length / 2) + 1;
  const columns = order.filter((p) => (freq.get(p) ?? 0) >= majority);
  if (columns.length < 2) {
    // degrade: one text column of whole-element innerText (non-repeating / unique mark → single row)
    return { columns: ['text'], rows: matches.map((m) => ({ text: innerText(m) })) };
  }
  const rows = perMatch.map((cells) => {
    const byPath = new Map<string, string>();
    for (const c of cells) if (!byPath.has(c.path)) byPath.set(c.path, c.text);
    const row: Record<string, string> = {};
    for (const col of columns) row[col] = byPath.get(col) ?? '';
    return row;
  });
  return { columns, rows };
}

export interface ExtractSetInput {
  tab_id: string;
  mark_id: string;
  exclude_refs?: string[];
  follow_pagination?: boolean;
  max_pages?: number;
  max_rows?: number;
}

export interface ClusterOk {
  subtrees: MatchSubtree[];
  refs: string[];
  /** How many of the caller's exclude_refs actually matched (for the user-facing `excluded` count). */
  excludedCount?: number;
}
export interface ClusterErr {
  error: 'no_such_mark';
}
export interface FollowResult {
  followed: boolean;
  pendingApproval?: string;
}
export interface PersistArgs {
  columns: string[];
  rows: Record<string, string>[];
}
export interface PersistResult {
  id: number;
  inserted: boolean;
  contentHash: string;
  columns: string[];
  rows: Record<string, string>[];
}

export interface ExtractSetDeps {
  /** generalize(mark) minus exclude_refs → matched subtrees; runs in the host over the live DOM. */
  resolveCluster(markId: string, excludeRefs: string[]): Promise<ClusterOk | ClusterErr>;
  isCredentialPage(): Promise<boolean>;
  /** Gated Document-class nav to the next page; the caller re-snapshots before the next resolveCluster. */
  followNextPage(): Promise<FollowResult>;
  persist(args: PersistArgs): Promise<PersistResult>;
  caps: { maxPagesCeiling: number; maxRowsCeiling: number; defaultPages: number; defaultRows: number };
}

export interface ExtractSetResult {
  stage?: 'refused' | 'pending_approval';
  reason?: string;
  /** approval id on pending_approval */
  id?: string;
  error_reason?: string;
  hint?: string;
  columns?: string[];
  rows?: Record<string, string>[];
  pages_followed?: number;
  truncated?: boolean;
  excluded?: number;
  artifact_id?: number;
}

const clampCeil = (v: number | undefined, def: number, ceil: number): number =>
  Math.max(1, Math.min(ceil, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def));

export async function extractSet(input: ExtractSetInput, deps: ExtractSetDeps): Promise<ExtractSetResult> {
  // Credential gate at entry — refuse at source, extract/persist nothing.
  if (await deps.isCredentialPage()) return { stage: 'refused', reason: 'credential_context' };

  const maxPages = clampCeil(input.max_pages, deps.caps.defaultPages, deps.caps.maxPagesCeiling);
  const maxRows = clampCeil(input.max_rows, deps.caps.defaultRows, deps.caps.maxRowsCeiling);
  const excludeRefs = input.exclude_refs ?? [];

  const collected: MatchSubtree[] = [];
  let excluded = 0;
  let pagesFollowed = 0;
  let truncated = false;

  for (let page = 0; ; page += 1) {
    const cluster = await deps.resolveCluster(input.mark_id, excludeRefs);
    if ('error' in cluster) {
      return { error_reason: cluster.error, hint: 'The marked pattern did not resolve on the current page — re-mark or re-observe.' };
    }
    // exclude_refs is a static list applied by resolveCluster; count the matches it actually dropped ONCE
    // (page 0), not per page (a multi-page follow re-applies the same static list each page).
    if (page === 0) excluded = cluster.excludedCount ?? 0;
    for (const st of cluster.subtrees) {
      if (collected.length >= maxRows) {
        truncated = true;
        break;
      }
      collected.push(st);
    }
    if (truncated) break;
    if (!input.follow_pagination || page + 1 >= maxPages) {
      if (input.follow_pagination && page + 1 >= maxPages) truncated = true;
      break;
    }
    const follow = await deps.followNextPage();
    if (follow.pendingApproval) return { stage: 'pending_approval', id: follow.pendingApproval };
    if (!follow.followed) break;
    // A hop that lands on a credential page terminates the follow; that page's rows are never extracted.
    if (await deps.isCredentialPage()) break;
    pagesFollowed += 1;
  }

  const inferred = inferRows(collected);
  // Neutralize the untrusted-data boundary marker on every cell BEFORE persist (dual-sink: the renderer
  // neutralizes again at its own boundary — a persisted extraction re-read via find_similar flows a
  // different path and cannot assume the stored body was neutralized).
  const rows = inferred.rows.map((r) => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(r)) out[neutralizeMarkers(k)] = neutralizeMarkers(r[k]);
    return out;
  });
  const columns = inferred.columns.map(neutralizeMarkers);

  const persisted = await deps.persist({ columns, rows });
  return {
    columns,
    rows,
    pages_followed: pagesFollowed,
    ...(truncated ? { truncated } : {}),
    ...(excludeRefs.length ? { excluded } : {}),
    artifact_id: persisted.id,
  };
}
