import { parseHTML } from 'linkedom';
import type { MetadataData } from '../types.js';

// Canonical metadata extractor. fetch and extract mode=metadata both route
// through here so the two paths never diverge on which fields they surface.
function getMetaContent(doc: Document, nameOrProperty: string): string | undefined {
  const el =
    doc.querySelector(`meta[name="${nameOrProperty}"]`) ??
    doc.querySelector(`meta[property="${nameOrProperty}"]`);
  return el?.getAttribute('content') ?? undefined;
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v.trim().length > 0) return v;
  }
  return undefined;
}

export function extractMetadata(html: string): MetadataData {
  const { document: doc } = parseHTML(html);
  const result: MetadataData = {};

  const title = doc.querySelector('title')?.textContent?.trim();
  if (title) result.title = title;

  const description = firstPresent(
    getMetaContent(doc, 'description'),
    getMetaContent(doc, 'og:description'),
    getMetaContent(doc, 'twitter:description'),
  );
  if (description) result.description = description;

  const author = getMetaContent(doc, 'author');
  if (author) result.author = author;

  const date = firstPresent(
    getMetaContent(doc, 'date'),
    getMetaContent(doc, 'article:published_time'),
  );
  if (date) result.date = date;

  const keywords = getMetaContent(doc, 'keywords');
  if (keywords) {
    result.keywords = keywords.split(',').map((k) => k.trim()).filter(Boolean);
  }

  // og:image is the primary, but some sites (pgedge.com being the bench
  // exemplar) ship only twitter:image or og:image:secure_url. Fall back so
  // callers see an image whenever the page advertises one.
  const ogImage = firstPresent(
    getMetaContent(doc, 'og:image'),
    getMetaContent(doc, 'og:image:secure_url'),
    getMetaContent(doc, 'twitter:image'),
    getMetaContent(doc, 'twitter:image:src'),
  );
  if (ogImage) result.og_image = ogImage;

  const ogType = firstPresent(
    getMetaContent(doc, 'og:type'),
    getMetaContent(doc, 'twitter:card'),
  );
  if (ogType) result.og_type = ogType;

  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (canonical) result.canonical_url = canonical;

  return result;
}
