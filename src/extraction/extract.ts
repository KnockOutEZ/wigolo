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

export function extractTables(html: string): TableData[] {
  const { document: doc } = parseHTML(html);
  const allTables = Array.from(doc.querySelectorAll('table'));
  if (allTables.length === 0) return [];
  // Skip chrome tables (navbox / infobox / role=navigation) so callers get
  // real data tables only — H6.
  const tables = allTables.filter((t) => !isWikipediaChromeTable(t));
  if (tables.length === 0) return [];

  return tables.map((table) => {
    const caption = table.querySelector('caption')?.textContent?.trim() || undefined;

    const thElements = table.querySelectorAll('thead th');
    let headers: string[];
    let bodyRows: Element[];

    if (thElements.length > 0) {
      headers = Array.from(thElements).map((th) => (th.textContent ?? '').trim());
      bodyRows = Array.from(table.querySelectorAll('tbody tr'));
      if (bodyRows.length === 0) {
        const allRows = Array.from(table.querySelectorAll('tr'));
        bodyRows = allRows.slice(1);
      }
    } else {
      const allRows = Array.from(table.querySelectorAll('tr'));
      const firstRow = allRows[0];
      const firstRowThs = firstRow ? Array.from(firstRow.querySelectorAll('th')) : [];

      if (firstRowThs.length > 0) {
        headers = firstRowThs.map((th) => (th.textContent ?? '').trim());
        bodyRows = allRows.slice(1);
      } else {
        const cellCount = firstRow ? firstRow.querySelectorAll('td').length : 0;
        headers = Array.from({ length: cellCount }, (_, i) => `col_${i + 1}`);
        bodyRows = allRows;
      }
    }

    const rows = bodyRows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      const obj: Record<string, string> = {};
      headers.forEach((header, i) => {
        obj[header] = (cells[i]?.textContent ?? '').trim();
      });
      return obj;
    });

    return { caption, headers, rows };
  });
}
