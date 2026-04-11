import { parseHTML } from 'linkedom';
import type { MetadataData } from '../types.js';

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
