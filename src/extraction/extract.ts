import { parseHTML } from 'linkedom';
import type { MetadataData, TableData } from '../types.js';

function getMetaContent(doc: Document, nameOrProperty: string): string | undefined {
  const el =
    doc.querySelector(`meta[name="${nameOrProperty}"]`) ??
    doc.querySelector(`meta[property="${nameOrProperty}"]`);
  return el?.getAttribute('content') ?? undefined;
}

export function extractMetadata(html: string): MetadataData {
  const { document: doc } = parseHTML(html);
  const result: MetadataData = {};

  const title = doc.querySelector('title')?.textContent?.trim();
  if (title) result.title = title;

  const description =
    getMetaContent(doc, 'description') ?? getMetaContent(doc, 'og:description');
  if (description) result.description = description;

  const author = getMetaContent(doc, 'author');
  if (author) result.author = author;

  const date =
    getMetaContent(doc, 'date') ?? getMetaContent(doc, 'article:published_time');
  if (date) result.date = date;

  const keywords = getMetaContent(doc, 'keywords');
  if (keywords) {
    result.keywords = keywords.split(',').map((k) => k.trim()).filter(Boolean);
  }

  const ogImage = getMetaContent(doc, 'og:image');
  if (ogImage) result.og_image = ogImage;

  return result;
}

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

export function extractTables(html: string): TableData[] {
  const { document: doc } = parseHTML(html);
  const tables = doc.querySelectorAll('table');
  if (tables.length === 0) return [];

  return Array.from(tables).map((table) => {
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
