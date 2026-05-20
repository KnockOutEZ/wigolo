import { parseHTML } from 'linkedom';
import { readabilityExtract } from '../readability.js';
import { extractJsonLd } from '../jsonld.js';
import type { ExtractionResult } from '../../types.js';

const META_DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[itemprop="datePublished"]',
  'meta[name="date"]',
  'meta[name="dc.date"]',
  'meta[name="DC.date.issued"]',
];

export async function extractNews(html: string, url: string): Promise<ExtractionResult | null> {
  const base = readabilityExtract(html, url);
  if (!base) return null;

  if (!base.metadata.date) {
    const date = findPublishedDate(html);
    if (date) {
      return { ...base, metadata: { ...base.metadata, date } };
    }
  }

  return base;
}

function findPublishedDate(html: string): string | undefined {
  if (!html) return undefined;

  let document: Document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return undefined;
  }

  for (const selector of META_DATE_SELECTORS) {
    const el = document.querySelector(selector);
    const content = el?.getAttribute('content')?.trim();
    if (content && isValidDate(content)) return content;
  }

  const article = document.querySelector('article');
  const root: ParentNode = article ?? document;
  const timeEl = root.querySelector('time[datetime]');
  const datetime = timeEl?.getAttribute('datetime')?.trim();
  if (datetime && isValidDate(datetime)) return datetime;

  try {
    const blocks = extractJsonLd(html);
    for (const block of blocks) {
      const published = block['datePublished'];
      if (typeof published === 'string' && isValidDate(published)) {
        return published;
      }
    }
  } catch {
    // jsonld parse failures already swallowed inside extractJsonLd
  }

  return undefined;
}

function isValidDate(value: string): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}
