import { parseHTML } from 'linkedom';
import { extractJsonLd } from '../jsonld.js';
import type { ExtractionResult } from '../../types.js';

const MIN_CONTENT_THRESHOLD = 100;

export async function extractProduct(html: string, _url: string): Promise<ExtractionResult | null> {
  if (!html) return null;

  const fromJsonLd = tryJsonLd(html);
  if (fromJsonLd) return fromJsonLd;

  return tryOpenGraph(html);
}

function tryJsonLd(html: string): ExtractionResult | null {
  let blocks: Record<string, unknown>[];
  try {
    blocks = extractJsonLd(html);
  } catch {
    return null;
  }

  const product = blocks.find((block) => typeIncludes(block['@type'], 'product'));
  if (!product) return null;

  const name = stringField(product['name']);
  if (!name) return null;

  const lines: string[] = [`# ${name}`];

  const description = stringField(product['description']);
  if (description) lines.push('', description);

  const detailLines: string[] = [];
  const brand = readBrand(product['brand']);
  if (brand) detailLines.push(`**Brand:** ${brand}`);

  const offer = pickOffer(product['offers']);
  const price = offer ? stringField(offer['price']) : undefined;
  const currency = offer ? stringField(offer['priceCurrency']) : undefined;
  if (price) {
    detailLines.push(currency ? `**Price:** ${currency} ${price}` : `**Price:** ${price}`);
  }

  const rating = readRating(product['aggregateRating']);
  if (rating) detailLines.push(rating);

  const sku = stringField(product['sku']);
  if (sku) detailLines.push(`**SKU:** ${sku}`);

  if (detailLines.length > 0) {
    lines.push('', ...detailLines);
  }

  const markdown = lines.join('\n').trim();
  if (markdown.length < MIN_CONTENT_THRESHOLD) return null;

  const image = firstImage(product['image']);

  return {
    title: name,
    markdown,
    metadata: {
      ...(description ? { description } : {}),
      ...(image ? { og_image: image } : {}),
    },
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

function tryOpenGraph(html: string): ExtractionResult | null {
  let document: Document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return null;
  }

  const ogType = metaContent(document, 'meta[property="og:type"]')?.toLowerCase();
  if (ogType !== 'product' && ogType !== 'og:product') return null;

  const title = metaContent(document, 'meta[property="og:title"]');
  if (!title) return null;

  const description = metaContent(document, 'meta[property="og:description"]');
  const price = metaContent(document, 'meta[property="product:price:amount"]');
  const currency = metaContent(document, 'meta[property="product:price:currency"]');
  const image = metaContent(document, 'meta[property="og:image"]');

  const lines: string[] = [`# ${title}`];
  if (description) lines.push('', description);
  if (price) {
    lines.push('', currency ? `**Price:** ${currency} ${price}` : `**Price:** ${price}`);
  }

  const markdown = lines.join('\n').trim();
  if (markdown.length < MIN_CONTENT_THRESHOLD) return null;

  return {
    title,
    markdown,
    metadata: {
      ...(description ? { description } : {}),
      ...(image ? { og_image: image } : {}),
    },
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

function metaContent(document: Document, selector: string): string | undefined {
  const el = document.querySelector(selector);
  const content = el?.getAttribute('content')?.trim();
  return content && content.length > 0 ? content : undefined;
}

function typeIncludes(raw: unknown, want: string): boolean {
  const target = want.toLowerCase();
  if (typeof raw === 'string') return normalizeType(raw) === target;
  if (Array.isArray(raw)) {
    return raw.some((entry) => typeof entry === 'string' && normalizeType(entry) === target);
  }
  return false;
}

function normalizeType(raw: string): string {
  const tail = raw.split(/[/#:]/).pop() ?? raw;
  return tail.toLowerCase();
}

function stringField(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readBrand(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = readBrand(entry);
      if (name) return name;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>)['name'];
    return stringField(name);
  }
  return undefined;
}

function pickOffer(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry && typeof entry === 'object');
    return first as Record<string, unknown> | undefined;
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return undefined;
}

function readRating(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const rating = stringField(obj['ratingValue']);
  const count = stringField(obj['reviewCount']);
  if (!rating) return undefined;
  if (count) return `**Rating:** ${rating} (${count} reviews)`;
  return `**Rating:** ${rating}`;
}

function firstImage(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const img = firstImage(entry);
      if (img) return img;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const url = (value as Record<string, unknown>)['url'];
    return stringField(url);
  }
  return undefined;
}
