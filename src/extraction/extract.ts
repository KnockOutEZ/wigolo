import { parseHTML } from 'linkedom';
import type { TableData } from '../types.js';

// Re-export the canonical metadata extractor so legacy callers keep working.
// fetch (via pipeline.mergeMetadata) and extract mode=metadata both reach the
// same implementation now; see src/extraction/metadata.ts.
export { extractMetadata } from './metadata.js';

export function extractSelector(
  html: string,
  selector: string,
  multiple: boolean,
): string | string[] {
  const { document: doc } = parseHTML(html);

  if (multiple) {
    const elements = doc.querySelectorAll(selector);
    return Array.from(elements).map((el) => (el.textContent ?? '').trim());
  }

  const el = doc.querySelector(selector);
  return el ? (el.textContent ?? '').trim() : '';
}

// Class / role tokens that mark a table as Wikipedia chrome rather than
// content. Extracting tables on Wikipedia used to return the navbox cells
// ("Cite this page | Wikidata item") instead of the real article tables —
// these patterns are page navigation / metadata, not data.
const WIKIPEDIA_CHROME_CLASS_TOKENS = [
  'navbox',
  'infobox',
  'infobox-data-row-only',
  'sidebar',
  'metadata',
  'sistersitebox',
  'mw-collapsible',
];

function isWikipediaChromeTable(table: Element): boolean {
  const role = table.getAttribute('role')?.toLowerCase() ?? '';
  if (role === 'navigation' || role === 'presentation') return true;
  const className = table.getAttribute('class')?.toLowerCase() ?? '';
  if (!className) return false;
  const classes = className.split(/\s+/).filter(Boolean);
  return classes.some((cls) => WIKIPEDIA_CHROME_CLASS_TOKENS.includes(cls));
}

// A cell/row from a run-on single-column layout table longer than this is
// treated as prose, not data — the signal that the <table> is being used for
// page layout rather than to carry a real grid.
const RUN_ON_CELL_LEN = 120;

// True when `descendant` sits inside a table nested below `table` (i.e. the
// nearest enclosing <table> is not `table` itself). linkedom's
// querySelectorAll descends through nested tables, so we filter its output to
// the cells/rows that actually belong to the table we are mapping.
function belongsToNestedTable(descendant: Element, table: Element): boolean {
  let cur: Element | null = descendant.parentElement;
  while (cur && cur !== table) {
    if (cur.tagName.toLowerCase() === 'table') return true;
    cur = cur.parentElement;
  }
  return false;
}

function ownRows(table: Element): Element[] {
  return Array.from(table.querySelectorAll('tr')).filter(
    (tr) => !belongsToNestedTable(tr, table),
  );
}

function ownHeaderCells(table: Element, selector: string): Element[] {
  return Array.from(table.querySelectorAll(selector)).filter(
    (el) => !belongsToNestedTable(el, table),
  );
}

// Direct td/th children of a row — never descends into a cell's nested table.
function directCells(row: Element): Element[] {
  return Array.from(row.children).filter((c) => {
    const tag = c.tagName.toLowerCase();
    return tag === 'td' || tag === 'th';
  });
}

// A row whose only meaningful content is a nested <table> is a layout wrapper:
// the nested table is extracted on its own pass, so the parent must not
// re-emit the nested table's flattened text as a run-on cell.
function rowOnlyWrapsTable(row: Element): boolean {
  const cells = directCells(row);
  if (cells.length === 0) return false;
  const cellWithTable = cells.filter((c) => c.querySelector('table'));
  if (cellWithTable.length === 0) return false;
  // Text outside the nested table(s) must be negligible for this to count as
  // pure layout wrapping.
  for (const cell of cellWithTable) {
    const inner = Array.from(cell.querySelectorAll('table'));
    let innerText = '';
    for (const t of inner) innerText += t.textContent ?? '';
    const cellText = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
    const outsideLen = cellText.length - innerText.replace(/\s+/g, ' ').trim().length;
    if (outsideLen > RUN_ON_CELL_LEN) return false;
  }
  return true;
}

// A single-column layout table (headers === ['col_1']) whose rows are long
// run-on blobs is a layout table, not data. Salvage it as list-style rows so
// callers still see the content, capped to a sane length, and never as a
// header-less run-on blob table.
function salvageDegenerate(bodyRows: Element[]): TableData | null {
  const items: Record<string, string>[] = [];
  for (const row of bodyRows) {
    const text = (row.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > RUN_ON_CELL_LEN) continue; // drop run-on prose blobs
    items.push({ item: text });
  }
  if (items.length === 0) return null;
  return { headers: ['item'], rows: items };
}

// The lead cell of a listing record: a rank ordinal like "1", "1.", "12)".
// Legacy nested-table listings (HN-class front pages) start each story with
// this and spread the story's title/meta across the FOLLOWING sparse rows.
const RANK_ORDINAL_RE = /^\d{1,4}[.)]?$/;

function cellTexts(row: Element): string[] {
  return directCells(row).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
}

function firstNonEmpty(cells: string[]): string {
  for (const c of cells) if (c) return c;
  return '';
}

// A row starts a new listing record when its first non-empty cell is a rank
// ordinal — the canonical, layout-agnostic marker of a per-story listing row.
function isRecordStart(row: Element): boolean {
  return RANK_ORDINAL_RE.test(firstNonEmpty(cellTexts(row)));
}

// A header-less multi-row-per-record listing lays out ONE logical record as a
// cycle of rows: a rank+title row, then meta/continuation rows, then a spacer.
// Emitting each physical <tr> as its own row yields an interleaved col_N dump
// that is useless to an agent and matches no schema field. Detect the pattern
// — several rank-started record groups, with the majority of rows being sparse
// continuation/empty rows — so a DENSE data grid (every row fully populated,
// no rank cycle) is never touched.
function isInterleavedListing(bodyRows: Element[], columnCount: number): boolean {
  if (columnCount < 2) return false;
  const starts = bodyRows.filter(isRecordStart);
  // At least three records and, since every record spans >1 physical row, the
  // record-start rows must be a strict minority of the rows.
  if (starts.length < 3) return false;
  if (starts.length >= bodyRows.length) return false;
  // Sparsity gate: a real dense grid fills (near) every cell of its column
  // grid. An interleaved listing leaves most of the grid empty — spacer rows
  // with no cells, colspan gaps, single-field meta rows. Measure filled cells
  // against the full rows×columns grid so a zero-cell spacer still counts as
  // empty. Require over half the grid to be empty.
  let filled = 0;
  for (const row of bodyRows) {
    for (const c of cellTexts(row)) if (c) filled++;
  }
  const gridCells = bodyRows.length * columnCount;
  if (gridCells === 0) return false;
  return filled / gridCells < 0.5;
}

// An anchor whose whole text is a metric/timestamp — "342 points",
// "128 comments", "3 hours ago", "reply". These are meta links, never the
// record's title, so the title selection skips them regardless of length.
const META_ANCHOR_RE =
  /^\d[\d,]*\s*(?:point|comment|vote|upvote|reply|answer|view|share|like|day|hour|minute|second|week|month|year)s?(?:\s+ago)?$/i;

// An href that points at a user/author profile rather than the record's
// content. On a byline-first listing the author link precedes the story link,
// so a profile-style href must not be chosen as the title.
const PROFILE_HREF_RE = /(?:^|\/)(?:u|user|users|author|authors|profile|people|member|members)\/|\/@[^/]+\/?$/i;

// The record's title anchor is chosen deterministically in DOM order, in
// preference tiers so a byline-first layout still picks the story link:
//   1. first non-metric, non-byline anchor (the story link), else
//   2. first non-metric anchor (title link with no better option), else
//   3. the longest anchor (every anchor read as a metric).
// Vote arrows are empty; "342 points" / "3 hours ago" are metric links; an
// "/u/jane" author link is a byline — all deprioritised. Returns the anchor's
// href + text, or null when the record carries no linked title.
function primaryAnchor(group: Element[]): { href: string; text: string } | null {
  let firstContent: { href: string; text: string } | null = null;
  let firstNonMeta: { href: string; text: string } | null = null;
  let longest: { href: string; text: string } | null = null;
  for (const row of group) {
    for (const a of row.querySelectorAll('a[href]')) {
      const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const href = a.getAttribute('href') ?? '';
      const cand = { href, text };
      if (!longest || text.length > longest.text.length) longest = cand;
      if (META_ANCHOR_RE.test(text)) continue;
      if (!firstNonMeta) firstNonMeta = cand;
      if (!firstContent && !PROFILE_HREF_RE.test(href)) firstContent = cand;
    }
  }
  return firstContent ?? firstNonMeta ?? longest;
}

// A short numeric metric cell inside a record's meta content ("342 points",
// "128 comments"). We surface the bare integer as a typed field so consumers
// read a number, not prose.
const METRIC_RE = /\b(\d[\d,]*)\b/g;

// Collapse an interleaved listing into ONE row per record with DETERMINISTIC
// field binding: the rank ordinal, the story anchor's text as the title (never
// "longest cell", which swapped title<->meta when the meta line ran longer),
// the story anchor's href, the remaining non-title cell text as meta, and each
// numeric metric surfaced as a typed num_N field. Spacer/empty rows contribute
// nothing.
function segmentInterleavedListing(bodyRows: Element[]): TableData | null {
  const groups: Element[][] = [];
  let current: Element[] | null = null;
  for (const row of bodyRows) {
    if (isRecordStart(row)) {
      current = [row];
      groups.push(current);
    } else if (current) {
      current.push(row);
    }
  }
  if (groups.length < 3) return null;

  const rows: Record<string, string>[] = [];
  for (const group of groups) {
    const texts: string[] = [];
    for (const row of group) {
      for (const c of cellTexts(row)) if (c) texts.push(c);
    }
    if (texts.length === 0) continue;

    const obj: Record<string, string> = {};
    // The rank ordinal leads a record; strip it into its own column so the
    // remaining text is clean title/meta content.
    let rest = texts;
    if (RANK_ORDINAL_RE.test(texts[0])) {
      obj.rank = texts[0];
      rest = texts.slice(1);
    }

    // Deterministic title = the story anchor's text; fall back to the first
    // non-empty cell only when the record carries no linked title.
    const anchor = primaryAnchor(group);
    const title = anchor?.text ?? rest[0] ?? '';
    if (title) obj.title = title;
    if (anchor?.href) obj.href = anchor.href;

    // Meta = the record's remaining cell text with the title text removed, so
    // the title is never duplicated into meta.
    const metaParts = rest.filter((t) => t !== title);
    const meta = metaParts.join(' ').replace(/\s+/g, ' ').trim();
    if (meta) {
      obj.meta = meta;
      const nums = meta.match(METRIC_RE);
      if (nums) {
        nums.slice(0, 4).forEach((n, i) => {
          obj[`num_${i + 1}`] = n.replace(/,/g, '');
        });
      }
    }
    if (Object.keys(obj).length > 0) rows.push(obj);
  }
  if (rows.length < 3) return null;

  const headerSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
  return { headers: Array.from(headerSet), rows };
}

export function extractTables(html: string): TableData[] {
  const { document: doc } = parseHTML(html);
  const allTables = Array.from(doc.querySelectorAll('table'));
  if (allTables.length === 0) return [];
  // Skip chrome tables (navbox / infobox / role=navigation) so callers get
  // real data tables only — H6.
  const tables = allTables.filter((t) => !isWikipediaChromeTable(t));
  if (tables.length === 0) return [];

  const out: TableData[] = [];
  for (const table of tables) {
    const caption = table.querySelector('caption')?.textContent?.trim() || undefined;

    // Header + row selection is scoped to THIS table's own cells; a nested
    // <table> inside a <td> must not lend its headers/rows to the parent.
    const thElements = ownHeaderCells(table, 'thead th');
    let headers: string[];
    let bodyRows: Element[];
    // True only when headers were synthesised (no <th> anywhere): the sole
    // case where an interleaved multi-row-per-record listing can hide.
    let headerless = false;

    if (thElements.length > 0) {
      headers = thElements.map((th) => (th.textContent ?? '').trim());
      bodyRows = ownRows(table).filter((tr) => {
        // exclude the thead rows we already consumed as headers
        let cur: Element | null = tr.parentElement;
        while (cur && cur !== table) {
          if (cur.tagName.toLowerCase() === 'thead') return false;
          cur = cur.parentElement;
        }
        return true;
      });
      if (bodyRows.length === 0) {
        bodyRows = ownRows(table).slice(1);
      }
    } else {
      const allRows = ownRows(table);
      const firstRow = allRows[0];
      const firstRowThs = firstRow ? directCells(firstRow).filter((c) => c.tagName.toLowerCase() === 'th') : [];

      if (firstRowThs.length > 0) {
        headers = firstRowThs.map((th) => (th.textContent ?? '').trim());
        bodyRows = allRows.slice(1);
      } else {
        const cellCount = firstRow ? directCells(firstRow).length : 0;
        headers = Array.from({ length: cellCount }, (_, i) => `col_${i + 1}`);
        bodyRows = allRows;
        headerless = true;
      }
    }

    // Drop rows that exist only to wrap a nested <table>; the nested table is
    // surfaced on its own pass, so keeping the wrapper would duplicate it as a
    // flattened run-on cell.
    bodyRows = bodyRows.filter((row) => !rowOnlyWrapsTable(row));
    if (bodyRows.length === 0) continue;

    // Degenerate single-column layout table: a table that yields only one
    // column of long run-on cells is a layout wrapper, not a data grid.
    // Emitting it as { col_1: <whole cell text> } gives an agent a useless
    // blob. Salvage as list rows (or skip) instead.
    if (headers.length <= 1) {
      const runOn = bodyRows.some((row) => {
        const cells = directCells(row);
        const text = (cells[0]?.textContent ?? row.textContent ?? '').replace(/\s+/g, ' ').trim();
        return cells.length <= 1 && text.length > RUN_ON_CELL_LEN;
      });
      if (runOn) {
        const salvaged = salvageDegenerate(bodyRows);
        if (salvaged) {
          salvaged.caption = caption;
          out.push(salvaged);
        }
        continue;
      }
    }

    // Interleaved multi-row-per-record listing (HN-class front page): a
    // header-less table whose stories each span a sparse cycle of rows. Collapse
    // to one row per record so callers (and schema fuzzy-match) read one story
    // per row instead of an interleaved col_N dump. Header-less + rank-cycle +
    // sparse gates keep a dense data grid untouched.
    if (headerless && isInterleavedListing(bodyRows, headers.length)) {
      const segmented = segmentInterleavedListing(bodyRows);
      if (segmented) {
        segmented.caption = caption;
        out.push(segmented);
        continue;
      }
    }

    const rows = bodyRows.map((row) => {
      const cells = directCells(row);
      const obj: Record<string, string> = {};
      headers.forEach((header, i) => {
        obj[header] = (cells[i]?.textContent ?? '').trim();
      });
      return obj;
    });

    // A row that produced zero populated cells contributes nothing (this is
    // the parent layout table wrapping a nested data table). Drop such
    // header-only tables so the nested table is not duplicated.
    if (rows.length === 0 || rows.every((r) => Object.values(r).every((v) => v === ''))) {
      continue;
    }

    out.push({ caption, headers, rows });
  }
  return out;
}
