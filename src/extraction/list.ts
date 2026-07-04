import { parseHTML } from 'linkedom';
import type { TableData } from '../types.js';

// Minimum number of structurally-parallel <li> siblings required to treat a
// list as a data grid. Below this it is a stray short list or a single record,
// not a listing — the same >=3 gate the div-grid detector uses.
const MIN_ITEMS = 3;

const MAX_CELL_LEN = 200;
const MAX_META_FIELDS = 6;

// A cell carrying a bare integer count / metric ("184", "57 comments").
// Digits with optional grouping separators; the value is captured as the typed
// numeric string so an agent/schema reads the metric as a number, not prose.
const NUMERIC_RE = /\b(\d[\d,]*)\b/;

function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

// Landmark ancestors whose lists are page chrome (site nav, footer link
// columns, header menus) — never data listings. A linked nav menu passes the
// anchor signal but is not a feed; the same guard the card detector uses keeps
// it out. NOTE: <aside> is deliberately NOT here — an aside can hold a genuine
// leaderboard/feed widget, so aside lists are gated on record quality instead.
const CHROME_LANDMARKS = new Set(['nav', 'footer', 'header']);

function inChromeLandmark(el: Element): boolean {
  let cur: Element | null = el.parentElement;
  while (cur) {
    if (CHROME_LANDMARKS.has(tag(cur))) return true;
    if ((cur.getAttribute('role') ?? '').toLowerCase() === 'navigation') return true;
    cur = cur.parentElement;
  }
  return false;
}

// A timestamp / relative-time cell ("2 hours ago", "3 days ago"). Comment
// threads carry these; they are NOT the count/point metric that marks a real
// data listing, so they must not qualify a record on their own.
const TIMESTAMP_RE =
  /\b\d+\s*(?:second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago\b|\b(?:yesterday|today)\b|\d{4}-\d{2}-\d{2}/i;

// Pagination / nav control labels that a listing title must never be — bare
// ordinals, "Next"/"Prev", "More", "Home". A real record has a descriptive
// title, not a page control.
const NAV_LABEL_RE =
  /^(?:\d+|next|prev|previous|first|last|more|older|newer|home|back|»|«|←|→|\.\.\.)$/i;

// An href points at a content record when it is a real path/URL — not an
// in-page fragment (#toc anchor), an empty/hash href, or a javascript: handler.
function isContentHref(href: string): boolean {
  const h = href.trim();
  if (!h || h === '#') return false;
  if (h.startsWith('#')) return false;
  if (/^javascript:/i.test(h)) return false;
  return true;
}

// A title reads as a real record heading when it is not a bare nav/pagination
// control and is descriptive — either multiple words or a reasonably long
// single token. Single short words (tag chips, breadcrumb crumbs, author
// handles) do not qualify on their own.
function isSubstantiveTitle(title: string): boolean {
  const t = title.trim();
  if (!t || NAV_LABEL_RE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  return t.length >= 12;
}

// A metric cell that is a genuine count/point (has a number) and is NOT a
// timestamp — the "340 points" of a leaderboard, not the "2 hours ago" of a
// comment.
function isContentMetric(text: string): boolean {
  if (!text || text.length > 40) return false;
  if (TIMESTAMP_RE.test(text)) return false;
  return NUMERIC_RE.test(text);
}

function textOf(el: Element | null): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_CELL_LEN ? collapsed : collapsed.slice(0, MAX_CELL_LEN - 1) + '…';
}

// Structural fingerprint of an <li>'s direct child tags — two items from the
// same repeated listing share this, so a container with mixed one-off <li>s
// (a nav menu spliced with a promo card) is not mistaken for a uniform grid.
function childShape(li: Element): string {
  return Array.from(li.children)
    .map((c) => tag(c))
    .sort()
    .join(',');
}

// The record's title text: its content-path anchor's text, else the item's own
// direct text (metrics stripped). Chrome anchors (fragment/js hrefs) do not
// contribute a title, so a TOC of #anchor links has no record title.
function recordTitle(li: Element): string {
  for (const a of li.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!isContentHref(href)) continue;
    const t = textOf(a);
    if (t) return t;
  }
  return '';
}

// An item qualifies as a listing record only with genuine data-listing shape,
// not the mere presence of a link (which every nav menu, TOC, breadcrumb, tag
// cloud, and comment byline also has). It needs EITHER:
//   - a content-path anchor whose text is a substantive title (a feed of
//     headlines), OR
//   - a non-timestamp numeric metric — a real count/point (leaderboard, ranked
//     list). A short name is fine here because the metric carries the data;
//     comment bylines carry only a timestamp, which isContentMetric rejects, so
//     "jane · 2 hours ago" does NOT qualify.
function hasRecordSignal(li: Element): boolean {
  const title = recordTitle(li);
  if (title.length > 0 && isSubstantiveTitle(title)) return true;

  for (const node of li.querySelectorAll('span, div, strong, em, b, small, time')) {
    if (node.children.length > 1) continue;
    if (isContentMetric(textOf(node))) return true;
  }
  return false;
}

// Direct <li> children of a list container (never descending into a nested
// sub-list, whose items belong to their own container pass).
function ownItems(list: Element): Element[] {
  return Array.from(list.children).filter((c) => tag(c) === 'li');
}

// Collect the metric cells of an item: short leaf-ish nodes bearing a number,
// excluding the primary anchor text. Each becomes a typed numeric field so the
// row exposes counts/points as parseable values.
function metricCells(li: Element, primaryAnchor: Element | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of li.querySelectorAll('span, div, strong, em, b, small, time')) {
    if (node.children.length > 1) continue;
    if (primaryAnchor && (node === primaryAnchor || primaryAnchor.contains(node))) continue;
    const t = textOf(node);
    if (!isContentMetric(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_META_FIELDS) break;
  }
  return out;
}

// Derive one row per list item: the primary anchor's text + href, plus each
// metric cell surfaced BOTH as its raw label text and as a typed numeric field
// (num_1, num_2 …) so schema/agent consumers can bind either.
function itemToRow(li: Element): Record<string, string> {
  const row: Record<string, string> = {};

  // Prefer the content-path anchor (the record's target) over an incidental
  // fragment/js link, so title/href bind to the story link, not a "#top" jump.
  let anchor: Element | null = null;
  for (const a of li.querySelectorAll('a[href]')) {
    if (isContentHref(a.getAttribute('href') ?? '')) {
      anchor = a;
      break;
    }
  }
  if (!anchor) anchor = li.querySelector('a[href]');
  if (anchor) {
    const title = textOf(anchor);
    if (title) row.title = truncate(title);
    const href = anchor.getAttribute('href') ?? '';
    if (href) row.href = truncate(href);
  }

  const metrics = metricCells(li, anchor);
  metrics.forEach((m, i) => {
    row[`meta_${i + 1}`] = truncate(m);
    const num = m.match(NUMERIC_RE);
    if (num) row[`num_${i + 1}`] = num[1].replace(/,/g, '');
  });

  // Fallback title when the item carries a metric but no anchor: use the
  // longest non-metric leaf text so the record is never anonymous.
  if (!row.title) {
    const direct = textOf(li);
    const withoutMetrics = metrics.reduce((acc, m) => acc.replace(m, ''), direct).trim();
    if (withoutMetrics) row.title = truncate(withoutMetrics);
  }

  return row;
}

// Is a list container a genuine repeated-sibling listing (>=MIN_ITEMS items
// sharing an inner shape, each carrying a record signal)? Nested-list chrome,
// short lists, and bare prose/nav lists all fail this and stay prose.
function qualifies(list: Element): Element[] | null {
  const items = ownItems(list);
  if (items.length < MIN_ITEMS) return null;

  const withSignal = items.filter(hasRecordSignal);
  // A strong majority of the items must be real records — a listing with one
  // stray decorative <li> still qualifies, a nav menu with a lone linked item
  // does not.
  if (withSignal.length < MIN_ITEMS) return null;
  if (withSignal.length / items.length < 0.6) return null;

  // Structural uniformity: the record items must share a dominant child shape,
  // so a mixed container (menu + promo) is rejected.
  const shapeCounts = new Map<string, number>();
  for (const li of withSignal) {
    const s = childShape(li);
    shapeCounts.set(s, (shapeCounts.get(s) ?? 0) + 1);
  }
  const dominant = Math.max(...shapeCounts.values());
  if (dominant < MIN_ITEMS) return null;

  // Title distinctness: a real listing's records have distinct headings. A
  // "Read more" / "Learn more" call-to-action list repeats one title across
  // every item — that is a widget row of buttons, not a data listing.
  const titles = withSignal.map(recordTitle).filter((t) => t.length > 0);
  if (titles.length >= MIN_ITEMS) {
    const distinct = new Set(titles.map((t) => t.toLowerCase()));
    if (distinct.size < 2) return null;
  }

  return withSignal;
}

/**
 * Detect generic repeated-sibling <ol>/<ul> listings — ranked feeds, result
 * lists, leaderboards rendered as bullet/numbered lists — and emit them as
 * TableData, one row per item. Each row captures the item's anchor href and
 * any typed numeric metrics (points / comments / counts). Purely structural:
 * NO site-specific class or tag is special-cased. Bare nav/prose lists (no
 * anchors + metrics, non-uniform shape, or below the >=3 gate) yield nothing.
 */
export function detectListTables(html: string): TableData[] {
  const { document: doc } = parseHTML(html);
  return detectListTablesFromDoc(doc);
}

export function detectListTablesFromDoc(doc: Document): TableData[] {
  const out: TableData[] = [];
  const seen = new Set<Element>();

  for (const list of doc.querySelectorAll('ol, ul')) {
    if (seen.has(list)) continue;
    if (inChromeLandmark(list)) continue;
    const items = qualifies(list);
    if (!items) continue;

    // A qualifying list nested inside another qualifying list is the inner
    // record; the outer pass already covers it, so skip nested containers.
    let nested = false;
    let cur: Element | null = list.parentElement;
    while (cur) {
      if ((tag(cur) === 'ol' || tag(cur) === 'ul') && seen.has(cur)) {
        nested = true;
        break;
      }
      cur = cur.parentElement;
    }
    if (nested) continue;
    seen.add(list);

    const rows = items.map(itemToRow).filter((r) => Object.keys(r).length > 0);
    if (rows.length < MIN_ITEMS) continue;

    const headerSet = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
    out.push({ headers: Array.from(headerSet), rows });
  }

  return out;
}
