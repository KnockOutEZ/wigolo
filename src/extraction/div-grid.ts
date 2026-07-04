import { parseHTML } from 'linkedom';
import type { TableData } from '../types.js';

// Minimum number of structurally-parallel repeated siblings required to treat a
// container as a grid. THIS is the gate — a class token like "price" is only a
// ranking hint (see RANK_TOKENS). A single product page with one .price must
// yield zero grid tables; two cards is below the gate and also yields zero.
const MIN_CARDS = 3;

// Class tokens that RANK a candidate container higher when choosing among
// several repeated-sibling groups. Never sufficient on their own — the
// >=MIN_CARDS structural-parallelism test always gates first.
const RANK_TOKENS = ['tier', 'plan', 'price', 'card', 'column', 'package', 'pricing'];

// Card content that looks like a price. Used both to rank and to derive the
// price column of a card.
const PRICE_CLASS = 'price';

const MAX_FEATURE_ITEMS = 12;
const MAX_CELL_LEN = 200;

// Table-native tags are handled by extractTables — a <tr>/<td> must never be
// mistaken for a div-grid card, or every real <table> would double-report as
// a phantom grid.
const TABLE_TAGS = new Set([
  'table',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'caption',
  'colgroup',
  'col',
]);

interface CandidateGroup {
  container: Element;
  cards: Element[];
  score: number;
}

function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

function classTokens(el: Element): Set<string> {
  const cls = el.getAttribute('class')?.toLowerCase() ?? '';
  return new Set(cls.split(/\s+/).filter(Boolean));
}

// Signature of an element's direct child tags — the structural fingerprint we
// compare siblings on. Two cards from the same grid share this fingerprint.
function childShape(el: Element): string {
  return Array.from(el.children)
    .map((c) => tag(c))
    .sort()
    .join(',');
}

// Landmark ancestors whose repeated children are page chrome (link columns,
// nav menus, banners) — never data grids.
const CHROME_LANDMARKS = new Set(['nav', 'footer', 'header']);

// A number- or currency-bearing cell — the data signal that separates a
// pricing/spec/comparison grid from repeated chrome. Digits, or a currency
// symbol, count. (A bare "Docs" / "About" nav label has neither.)
const DATA_CELL_RE = /\d|[$€£¥₹]/;

// Unambiguous "no listed number" pricing cues — call-to-action phrases and
// per-headcount units that only appear on pricing cells. This is a principled,
// small synonym set, NOT generic nav words: it deliberately excludes bare
// "pricing"/"price"/"contact" (footer/nav menu items) so the relax cannot open
// chrome. Per-headcount units (seat/user/member/agent) are pricing-specific on
// their own; a billing PERIOD (month/mo) is too generic ("3 times per month")
// so it is only accepted alongside a currency amount (see PRICE_PERIOD_RE).
const PRICE_CUE_RE =
  /\b(?:custom|contact sales|contact us for pricing|talk to (?:us|sales)|get (?:a )?(?:quote|demo)|request (?:a )?(?:quote|demo|pricing)|call (?:us|sales)|let'?s talk|by request|on request)\b|(?:\bper\s+|\/\s*)(?:seat|user|member|agent)s?\b/i;

// A billing period ("/month", "per mo") is a price cue ONLY when the same short
// cell also carries a currency amount — "$16/month" is a price, "posts per
// month" is blog cadence. Both conditions must hold in one node.
const PRICE_PERIOD_RE = /(?:\bper\s+|\/\s*)(?:month|mo|year|yr|annum)\b/i;
const CURRENCY_AMOUNT_RE = /[$€£¥₹]\s*\d|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp)\b/i;

// A price cue only counts as a DATA signal when it sits in a SHORT, standalone
// node (a price cell / small heading), never inside prose. A FAQ answer that
// says "contact sales for a custom quote" is not a price cell; capping the
// node's text length keeps such prose from qualifying a card.
const MAX_PRICE_CUE_NODE_LEN = 40;

function isPriceCueText(text: string): boolean {
  if (PRICE_CUE_RE.test(text)) return true;
  // Billing period requires a co-located currency amount to qualify.
  return PRICE_PERIOD_RE.test(text) && CURRENCY_AMOUNT_RE.test(text);
}

// True when a card has a short descendant node whose text reads as a
// non-numeric price cue. Scoped to leaf-ish small nodes (headings, spans,
// divs, dt/dd, p, strong/em) so we probe price-cell candidates, not the whole
// card's flattened prose.
function hasPriceCueCell(el: Element): boolean {
  return firstPriceCueCell(el) !== null;
}

// The text of the first short leaf-ish node that reads as a price cue, or null.
function firstPriceCueCell(el: Element): string | null {
  for (const node of el.querySelectorAll(
    'span, div, p, strong, em, b, h1, h2, h3, h4, h5, h6, dt, dd, li',
  )) {
    // Only consider leaf-ish nodes: a wrapper div containing the whole card
    // would trivially "contain" the cue; we want the price cell itself.
    if (node.children.length > 1) continue;
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_PRICE_CUE_NODE_LEN) continue;
    if (isPriceCueText(text)) return text;
  }
  return null;
}

// True when the element sits inside a <nav>/<footer>/<header> landmark.
function inChromeLandmark(el: Element): boolean {
  let cur: Element | null = el.parentElement;
  while (cur) {
    if (CHROME_LANDMARKS.has(tag(cur))) return true;
    cur = cur.parentElement;
  }
  return false;
}

// Count a card's feature-list items (<li>) whose text carries a number or
// currency symbol — the data-ness signal. Scoped to <li> deliberately:
// counting arbitrary prose children (<p>/<time>) let a comment thread with
// dates and incidental numbers ("15 seconds", "top 10") masquerade as a spec
// grid. A real pricing/spec/comparison card lists its data in <li> items.
function numericCellCount(el: Element): number {
  let n = 0;
  for (const li of el.querySelectorAll('li')) {
    if (DATA_CELL_RE.test(li.textContent ?? '')) n++;
  }
  return n;
}

// A "card" must carry a genuine DATA signal, not just a heading + list.
// heading+list alone matched footer link columns, blog/team/FAQ grids — page
// chrome, not tabular data. A card qualifies only when it (a) carries a
// [class*=price] element, (b) has >=2 numeric/currency-bearing cells (a spec /
// comparison / pricing grid), or (c) has a short non-numeric price-cue cell
// ("Custom", "Contact sales", "$X/user/month"). Cards under a
// <nav>/<footer>/<header> landmark are chrome and never qualify — the landmark
// guard runs FIRST so the price-cue relax can never open footer/nav chrome.
function hasCardShape(el: Element): boolean {
  // A table row/cell is not a card — those are extractTables' job.
  if (TABLE_TAGS.has(tag(el))) return false;
  if (el.children.length === 0) return false;
  if (inChromeLandmark(el)) return false;

  const hasPriceish = el.querySelector(`[class*="${PRICE_CLASS}"]`) !== null;
  if (hasPriceish) return true;

  if (numericCellCount(el) >= 2) return true;

  return hasPriceCueCell(el);
}

// Do two elements look like siblings from the same repeated group? Same tag,
// and either overlapping class tokens or an identical child-shape signature.
function areParallel(a: Element, b: Element): boolean {
  if (tag(a) !== tag(b)) return false;
  const ta = classTokens(a);
  const tb = classTokens(b);
  for (const t of ta) {
    if (tb.has(t)) return true;
  }
  return childShape(a) === childShape(b) && childShape(a).length > 0;
}

// Partition a container's element children into groups of mutually-parallel
// siblings, then return the largest group if it clears the card-shape bar.
function largestParallelGroup(container: Element): Element[] | null {
  const children = Array.from(container.children).filter((c) => hasCardShape(c));
  if (children.length < MIN_CARDS) return null;

  const groups: Element[][] = [];
  for (const child of children) {
    const existing = groups.find((g) => areParallel(g[0], child));
    if (existing) existing.push(child);
    else groups.push([child]);
  }
  let best: Element[] | null = null;
  for (const g of groups) {
    if (g.length >= MIN_CARDS && (!best || g.length > best.length)) best = g;
  }
  return best;
}

function rankScore(container: Element, cards: Element[]): number {
  let score = cards.length;
  const containerCls = (container.getAttribute('class')?.toLowerCase() ?? '');
  for (const tokenName of RANK_TOKENS) {
    if (containerCls.includes(tokenName)) score += 2;
  }
  // A price signal inside the cards is a strong ranking hint (still not a gate).
  if (cards.some((c) => c.querySelector(`[class*="${PRICE_CLASS}"]`))) score += 3;
  return score;
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_CELL_LEN ? collapsed : collapsed.slice(0, MAX_CELL_LEN - 1) + '…';
}

// Non-visible tags whose text must never bleed into a cell value. Web
// components (e.g. animated number counters) inline a <style> block inside the
// price element; a naive textContent read dumps that CSS into the price cell.
const NON_TEXT_TAGS = new Set(['style', 'script', 'template', 'noscript']);

// textContent for a cell, minus any <style>/<script>/<template>/<noscript>
// descendant text — so a price cell rendered by a web component with an inline
// stylesheet yields "$10 per user/month", not the CSS that follows it.
function cellText(el: Element): string {
  // Fast path: no non-visible descendants, so a plain textContent read is safe.
  if (!el.querySelector('style, script, template, noscript')) {
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  const parts: string[] = [];
  const walk = (node: Element): void => {
    for (const child of node.childNodes) {
      const anyChild = child as { nodeType: number; textContent?: string | null };
      if (anyChild.nodeType === 3) {
        parts.push(anyChild.textContent ?? '');
      } else if (anyChild.nodeType === 1) {
        const childEl = child as Element;
        if (NON_TEXT_TAGS.has(tag(childEl))) continue;
        walk(childEl);
      }
    }
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Derive one row per card: a heading becomes the plan/name, a [class*=price]
// element becomes the price, and list items become numbered feature columns.
function cardToRow(card: Element): Record<string, string> {
  const row: Record<string, string> = {};

  const heading = card.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) row.name = truncate(cellText(heading));

  const priceEl = card.querySelector(`[class*="${PRICE_CLASS}"]`);
  if (priceEl) {
    row.price = truncate(cellText(priceEl));
  } else {
    // Non-numeric price ("Custom" / "Contact sales") lives in a node that
    // carries no price class; recover it from the first short price-cue cell so
    // the tier's price column isn't dropped.
    const cue = firstPriceCueCell(card);
    if (cue) row.price = truncate(cue);
  }

  const items = Array.from(card.querySelectorAll('li')).slice(0, MAX_FEATURE_ITEMS);
  items.forEach((li, i) => {
    const text = truncate(cellText(li));
    if (text) row[`feature_${i + 1}`] = text;
  });

  // Fallback: if no structured columns surfaced, keep the whole card text so
  // the row is never empty.
  if (Object.keys(row).length === 0) {
    const text = truncate(cellText(card));
    if (text) row.text = text;
  }
  return row;
}

function buildTable(group: CandidateGroup): TableData {
  const rows = group.cards.map(cardToRow);
  // Union the keys across cards so headers cover every column any card carries.
  const headerSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
  const headers = Array.from(headerSet);

  // Caption from the nearest preceding heading, if any.
  let caption: string | undefined;
  const container = group.container;
  const prevHeading =
    container.previousElementSibling && /^h[1-6]$/.test(tag(container.previousElementSibling))
      ? container.previousElementSibling
      : container.parentElement?.querySelector('h1, h2, h3, h4, h5, h6') ?? null;
  if (prevHeading) {
    const t = truncate(prevHeading.textContent ?? '');
    if (t) caption = t;
  }

  return caption ? { caption, headers, rows } : { headers, rows };
}

/**
 * Detect repeated-sibling card/grid structures (div/flex pricing tiers, plan
 * cards, comparison columns) that carry no <table> markup and emit them as
 * TableData — one table per grid, one row per card.
 *
 * The GATE is >=MIN_CARDS structurally-parallel siblings each with a card
 * shape; class tokens only rank candidates. This keeps single-product pages
 * and short feature lists from producing phantom tables.
 */
export function detectDivGridTables(html: string): TableData[] {
  const { document: doc } = parseHTML(html);
  return detectDivGridTablesFromDoc(doc);
}

export function detectDivGridTablesFromDoc(doc: Document): TableData[] {
  const filtered = findGridGroups(doc);
  if (filtered.length === 0) return [];
  // Emit only grids with at least one derivable column (name / price /
  // feature_*). A table whose every column is the `text` fallback carried no
  // structure worth surfacing and is dropped — defense in depth against
  // repeated prose blocks slipping past the card-shape gate.
  return filtered
    .map(buildTable)
    .filter((t) => t.headers.some((h) => h !== 'text'));
}

function findGridGroups(doc: Document): CandidateGroup[] {
  const candidates: CandidateGroup[] = [];
  const seenContainers = new Set<Element>();

  // Any element can be a grid container; scan elements that have >=MIN_CARDS
  // element children as a cheap pre-filter.
  for (const container of doc.querySelectorAll('*')) {
    if (container.children.length < MIN_CARDS) continue;
    if (TABLE_TAGS.has(tag(container))) continue;
    if (seenContainers.has(container)) continue;
    const cards = largestParallelGroup(container);
    if (!cards) continue;
    seenContainers.add(container);
    candidates.push({ container, cards, score: rankScore(container, cards) });
  }

  if (candidates.length === 0) return [];

  // Drop candidates nested inside another candidate's cards (outer grid wins),
  // then sort by score so the strongest grid leads.
  const containers = candidates.map((c) => c.container);
  const filtered = candidates.filter(
    (c) => !containers.some((other) => other !== c.container && other.contains(c.container)),
  );
  filtered.sort((a, b) => b.score - a.score);
  return filtered;
}

const NARROW_MIN_RATIO = 0.3;

function textLen(el: Element | null): number {
  if (!el) return 0;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

/**
 * Narrow markdown-oriented extraction to a div/flex-grid card region by
 * removing NON-card siblings around the grid container (sibling-removal up the
 * ancestor chain to <body> — never subtree descent, so card internals are
 * preserved). Two-factor guarded: fires only when (1) a grid with a price
 * signal is detected AND (2) the grid is a substantial fraction of body text.
 * Returns the input unchanged on non-grid pages so markdown extraction of
 * ordinary articles is unaffected.
 */
export function narrowToGrid(html: string): string {
  try {
    const { document } = parseHTML(html);
    const body = document.querySelector('body');
    if (!body) return html;

    const groups = findGridGroups(document);
    if (groups.length === 0) return html;

    // Factor 1: only a pricing-style grid (cards carry a price signal) is a
    // strong enough signal to justify pruning the surrounding page.
    const priced = groups.find((g) =>
      g.cards.some((c) => c.querySelector(`[class*="${PRICE_CLASS}"]`)),
    );
    if (!priced) return html;

    // Factor 2: the grid container must be a meaningful fraction of the page,
    // otherwise a small pricing widget on a content page would nuke the article.
    const bodyText = textLen(body);
    if (bodyText <= 0) return html;
    if (textLen(priced.container) / bodyText < NARROW_MIN_RATIO) return html;

    pruneToContainer(body, priced.container);
    return document.toString();
  } catch {
    return html;
  }
}

// Keep only the container's ancestor chain inside <body>, dropping every
// sibling at each level. Mirrors content-root's pruneToRoot but targets the
// grid container.
function pruneToContainer(body: Element, container: Element): void {
  let node: Node = container;
  while (node.parentNode && node !== body) {
    const parent = node.parentNode;
    for (const sib of Array.from(parent.childNodes)) {
      if (sib !== node) parent.removeChild(sib);
    }
    node = parent;
  }
}
