import { parseHTML } from 'linkedom';
import type { StructuredData, TableData, DefinitionPair, ChartHint, KeyValuePair } from '../types.js';
import { extractTables } from './extract.js';
import { extractJsonLd } from './jsonld.js';

const MAX_VALUE_LEN = 400;
const MAX_ITEMS_PER_TYPE = 200;

// Entry point. Collects every structured-data pattern we can surface from
// raw HTML so host LLMs receive a rich, schema-free brief without needing
// to re-parse the page.
export function extractStructured(html: string): StructuredData {
  const { document: doc } = parseHTML(html);

  const tables = extractTables(html);
  const jsonld = extractJsonLd(html);
  const definitions = extractDefinitions(doc);
  const chart_hints = extractChartHints(doc);
  const key_value_pairs = extractKeyValuePairs(doc);

  return {
    tables,
    definitions,
    jsonld,
    chart_hints,
    key_value_pairs,
  };
}

// <dl><dt>Term</dt><dd>Description</dd></dl> is the canonical key-value
// structure on the web; we also handle multiple <dd> per <dt> by joining.
function extractDefinitions(doc: Document): DefinitionPair[] {
  const out: DefinitionPair[] = [];
  const dlists = doc.querySelectorAll('dl');
  for (const dl of dlists) {
    const children = Array.from(dl.children);
    let pending: string | null = null;
    const buffer: string[] = [];
    const flush = () => {
      if (pending !== null && buffer.length > 0) {
        out.push({
          term: pending,
          description: truncate(buffer.join(' ').trim()),
        });
      }
      pending = null;
      buffer.length = 0;
    };
    for (const c of children) {
      const tag = c.tagName.toLowerCase();
      if (tag === 'dt') {
        flush();
        pending = truncate((c.textContent ?? '').trim());
      } else if (tag === 'dd' && pending !== null) {
        const text = (c.textContent ?? '').trim();
        if (text) buffer.push(text);
      }
      if (out.length >= MAX_ITEMS_PER_TYPE) break;
    }
    flush();
    if (out.length >= MAX_ITEMS_PER_TYPE) break;
  }
  return out;
}

// SVG / figure accessibility hints are the cheapest way to surface
// chart structure when the chart itself is rendered by JS. Host LLMs
// use these to describe a data viz without needing the underlying data.
function extractChartHints(doc: Document): ChartHint[] {
  const out: ChartHint[] = [];
  const seen = new Set<string>();

  for (const svg of doc.querySelectorAll('svg')) {
    const title = (svg.querySelector('title')?.textContent ?? '').trim();
    const aria_label = (svg.getAttribute('aria-label') ?? '').trim();
    const role = (svg.getAttribute('role') ?? '').trim();

    let figcaption: string | undefined;
    const figParent = closestFigure(svg);
    if (figParent) {
      const cap = figParent.querySelector('figcaption');
      figcaption = cap?.textContent?.trim() || undefined;
    }

    if (!title && !aria_label && !figcaption) continue;

    const hint: ChartHint = {
      ...(title ? { title: truncate(title) } : {}),
      ...(aria_label ? { aria_label: truncate(aria_label) } : {}),
      ...(figcaption ? { figcaption: truncate(figcaption) } : {}),
      type_hint: inferChartType(title, aria_label, role, figcaption),
    };
    const key = `${hint.title ?? ''}|${hint.aria_label ?? ''}|${hint.figcaption ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hint);
    if (out.length >= MAX_ITEMS_PER_TYPE) break;
  }

  // <figure><figcaption> without SVG still surfaces dataviz context for
  // pages that render charts as images or canvas.
  for (const fig of doc.querySelectorAll('figure')) {
    if (fig.querySelector('svg')) continue; // already handled above
    const cap = fig.querySelector('figcaption')?.textContent?.trim();
    if (!cap) continue;
    const key = `||${cap}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      figcaption: truncate(cap),
      type_hint: inferChartType('', '', '', cap),
    });
    if (out.length >= MAX_ITEMS_PER_TYPE) break;
  }

  return out;
}

function closestFigure(el: Element): Element | null {
  let cur: Element | null = el.parentElement;
  while (cur) {
    if (cur.tagName.toLowerCase() === 'figure') return cur;
    cur = cur.parentElement;
  }
  return null;
}

function inferChartType(
  title: string,
  ariaLabel: string,
  role: string,
  figcaption?: string,
): ChartHint['type_hint'] {
  const all = [title, ariaLabel, role, figcaption ?? ''].join(' ').toLowerCase();
  if (/\b(chart|bar|line|pie|donut|scatter|area|histogram)\b/.test(all)) return 'chart';
  if (/\b(diagram|flow|architecture|topology)\b/.test(all)) return 'diagram';
  if (/\b(graph|network|tree)\b/.test(all)) return 'graph';
  if (role === 'img') return 'chart';
  return undefined;
}

// Comparison grids, spec sheets, and product info boxes often use
// explicit "Label: Value" or [data-label] patterns. We harvest those
// plus <meta name=...> pairs not already covered by extractMetadata.
function extractKeyValuePairs(doc: Document): KeyValuePair[] {
  const out: KeyValuePair[] = [];
  const seen = new Set<string>();

  // Microdata itemprop pairs
  for (const el of doc.querySelectorAll('[itemprop]')) {
    const key = el.getAttribute('itemprop') ?? '';
    const value = (el.getAttribute('content') ?? el.textContent ?? '').trim();
    if (!key || !value) continue;
    pushUnique(out, seen, { key, value: truncate(value), source: 'microdata' });
    if (out.length >= MAX_ITEMS_PER_TYPE) return out;
  }

  // data-* attributes where the name looks meaningful (>= 3 chars after data-)
  for (const el of doc.querySelectorAll('[data-label][data-value], [data-key][data-value]')) {
    const key = (el.getAttribute('data-label') ?? el.getAttribute('data-key') ?? '').trim();
    const value = (el.getAttribute('data-value') ?? '').trim();
    if (!key || !value) continue;
    pushUnique(out, seen, { key, value: truncate(value), source: 'data-attr' });
    if (out.length >= MAX_ITEMS_PER_TYPE) return out;
  }

  // Comparison grid rows: <div class="row"><div class="label">X</div><div class="value">Y</div></div>
  for (const row of doc.querySelectorAll('[class*="row"], [class*="spec"], [class*="field"]')) {
    const label = row.querySelector('[class*="label"], [class*="name"], [class*="key"], dt, th');
    const value = row.querySelector('[class*="value"], [class*="data"], dd, td');
    if (!label || !value) continue;
    const k = (label.textContent ?? '').trim();
    const v = (value.textContent ?? '').trim();
    if (!k || !v || k === v) continue;
    if (k.length > 100 || v.length === 0) continue;
    pushUnique(out, seen, { key: k, value: truncate(v), source: 'comparison-grid' });
    if (out.length >= MAX_ITEMS_PER_TYPE) return out;
  }

  // "Key: Value" text patterns within <li>/<p> — cheap heuristic for spec sheets
  for (const el of doc.querySelectorAll('li, p')) {
    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 300) continue;
    const m = text.match(/^([A-Z][A-Za-z0-9 _-]{1,40}):\s+(.+)$/);
    if (!m) continue;
    pushUnique(out, seen, { key: m[1].trim(), value: truncate(m[2].trim()), source: 'text-pattern' });
    if (out.length >= MAX_ITEMS_PER_TYPE) return out;
  }

  return out;
}

function pushUnique(
  list: KeyValuePair[],
  seen: Set<string>,
  pair: KeyValuePair,
): void {
  const key = `${pair.key.toLowerCase()}|${pair.value.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(pair);
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_VALUE_LEN) return collapsed;
  return collapsed.slice(0, MAX_VALUE_LEN - 1) + '…';
}

// Re-export types for callers that only import from this module.
export type { TableData } from '../types.js';
