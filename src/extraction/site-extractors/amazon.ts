import { parseHTML } from 'linkedom';
import type { Extractor, ExtractionResult } from '../../types.js';

export interface AmazonProduct {
  asin: string;
  title: string;
  brand: string;
  price: number | null;
  currency: string;
  rating: number;
  review_count: number;
  description: string;
  features: string[];
  specifications: Record<string, string>;
  images: string[];
  availability: string;
}

const AMAZON_HOSTS = new Set([
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.pl',
  'amazon.se',
  'amazon.com.tr',
  'amazon.ca',
  'amazon.com.mx',
  'amazon.com.br',
  'amazon.co.jp',
  'amazon.in',
  'amazon.com.au',
  'amazon.sg',
  'amazon.ae',
  'amazon.sa',
  'amzn.to',
  'a.co',
]);

const PRODUCT_PATH_RE = /\/(dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}\b/i;
const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})\b/i;

// Amazon frequently returns a generic "Looking for something?
// / Page Not Found" landing when an ASIN is unrecognized or when the request
// trips bot detection. The previous behavior was to silently extract an
// empty product record and pretend success. Detect the canonical "not
// found" / "robot check" phrases so we can refuse to produce fake site_data
// and tell the caller via fetch_failed="blocked".
const AMAZON_BLOCK_PATTERNS: RegExp[] = [
  /page not found/i,
  /not a functioning page on our site/i,
  /sorry,?\s*we just need to make sure you'?re not a robot/i,
  /to discuss automated access to amazon data/i,
  /enter the characters you see below/i,
];

export function detectAntiBotBlock(html: string): string | null {
  if (!html) return null;
  // Quick negative on real product pages: a #productTitle node is the
  // canonical signal that the page actually rendered a product. Skip the
  // expensive regex sweep when we see it — avoids any chance of a false
  // positive on a legitimate product whose description happens to include
  // a "not found" review snippet.
  if (/id="productTitle"/i.test(html.slice(0, 30_000))) return null;
  const sample = html.slice(0, 10_000);
  for (const re of AMAZON_BLOCK_PATTERNS) {
    if (re.test(sample)) return 'blocked';
  }
  return null;
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/US\s?\$/i, 'USD'],
  [/CA\s?\$/i, 'CAD'],
  [/AU\s?\$/i, 'AUD'],
  [/NZ\s?\$/i, 'NZD'],
  [/HK\s?\$/i, 'HKD'],
  [/S\s?\$/i, 'SGD'],
  [/R\$/i, 'BRL'],
  [/MX\$/i, 'MXN'],
  [/\$/, 'USD'],
  [/£|£/, 'GBP'],
  [/€|€/, 'EUR'],
  [/¥|¥/, 'JPY'],
  [/₹|₹/, 'INR'],
  [/₺|₺/, 'TRY'],
  [/₩|₩/, 'KRW'],
  [/zł|zł/i, 'PLN'],
  [/kr/i, 'SEK'],
  [/AED/i, 'AED'],
  [/SAR/i, 'SAR'],
];

const TRACKING_IMAGE_HINTS = ['/tracking/', '/x-locale/', 'transparent-pixel'];

const RESERVED_SPEC_KEY_RE = /^(__proto__|constructor|prototype)$/i;

function isAmazonHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (AMAZON_HOSTS.has(lower)) return true;
  // Cover www. and country subdomains uniformly (e.g. www.amazon.co.uk).
  for (const host of AMAZON_HOSTS) {
    if (lower === host || lower.endsWith(`.${host}`)) return true;
  }
  return false;
}

function isProductPath(pathname: string): boolean {
  return PRODUCT_PATH_RE.test(pathname);
}

function parseAsinFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = ASIN_RE.exec(u.pathname);
    return m ? m[1]!.toUpperCase() : null;
  } catch {
    return null;
  }
}

function parseAsinFromDom(document: Document): string | null {
  const candidate = document.querySelector('[data-asin]');
  const asin = candidate?.getAttribute('data-asin')?.trim();
  if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return asin.toUpperCase();
  return null;
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function parseTitle(document: Document): string {
  const el = document.querySelector('#productTitle');
  return textOf(el);
}

function parseBrand(document: Document): string {
  const overviewBrand = readOverviewRow(document, /^brand$/i);
  if (overviewBrand) return overviewBrand;

  const byline = document.querySelector('#bylineInfo');
  const raw = textOf(byline);
  if (!raw) return '';

  // Common Amazon byline phrasings.
  const stripped = raw
    .replace(/^Visit\s+the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .replace(/^Brand\s*:\s*/i, '')
    .replace(/^by\s+/i, '')
    .trim();
  return stripped;
}

function mapCurrencySymbol(text: string): string {
  for (const [re, code] of CURRENCY_SYMBOLS) {
    if (re.test(text)) return code;
  }
  return '';
}

function parsePriceAndCurrency(document: Document): { price: number | null; currency: string } {
  // Prefer the screen-reader-only a-offscreen text — Amazon writes the full
  // formatted price there as the canonical value (e.g. "$249.99", "£49.99").
  const offscreen = document.querySelector('#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, #price_inside_buybox, #priceblock_ourprice, #priceblock_saleprice, #priceblock_dealprice');
  const raw = textOf(offscreen);
  if (raw) {
    const currency = mapCurrencySymbol(raw);
    const numeric = raw.replace(/[^0-9.,]/g, '');
    const normalized = normalizeNumeric(numeric);
    const price = Number.isFinite(normalized) ? normalized : null;
    return { price, currency };
  }

  // Fallback: visible price split across a-price-whole + a-price-fraction.
  const whole = textOf(document.querySelector('#corePrice_feature_div .a-price-whole'));
  const fraction = textOf(document.querySelector('#corePrice_feature_div .a-price-fraction'));
  const symbol = textOf(document.querySelector('#corePrice_feature_div .a-price-symbol'));
  if (whole) {
    const combined = `${whole.replace(/[^0-9]/g, '')}.${fraction.replace(/[^0-9]/g, '') || '00'}`;
    const price = parseFloat(combined);
    return {
      price: Number.isFinite(price) ? price : null,
      currency: mapCurrencySymbol(symbol) || '',
    };
  }

  return { price: null, currency: '' };
}

function normalizeNumeric(raw: string): number {
  if (!raw) return NaN;
  // If both "," and "." are present, assume the later one is the decimal.
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    if (raw.lastIndexOf(',') > raw.lastIndexOf('.')) {
      return parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    }
    return parseFloat(raw.replace(/,/g, ''));
  }
  if (hasComma && !hasDot) {
    // Ambiguous: "1,234" (US thousands) vs "1,99" (EU decimal). Treat values
    // where the fractional part has exactly 2 digits and only one comma as
    // EU decimal, else as US thousands.
    const parts = raw.split(',');
    if (parts.length === 2 && parts[1]!.length === 2) {
      return parseFloat(raw.replace(',', '.'));
    }
    return parseFloat(raw.replace(/,/g, ''));
  }
  return parseFloat(raw);
}

function parseRating(document: Document): number {
  // Screen-reader text is the canonical source: "4.5 out of 5 stars".
  const candidates = [
    document.querySelector('#acrPopover .a-icon-alt'),
    document.querySelector('#averageCustomerReviews .a-icon-alt'),
    document.querySelector('[data-hook="rating-out-of-text"]'),
  ];
  for (const el of candidates) {
    const raw = textOf(el);
    const m = /([0-9]+(?:[.,][0-9]+)?)\s*out of/i.exec(raw);
    if (m) {
      const n = parseFloat(m[1]!.replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
  }
  // Title attribute fallback.
  const titleAttr = document.querySelector('#acrPopover')?.getAttribute('title') ?? '';
  const m = /([0-9]+(?:[.,][0-9]+)?)\s*out of/i.exec(titleAttr);
  if (m) {
    const n = parseFloat(m[1]!.replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function parseReviewCount(document: Document): number {
  const el = document.querySelector('#acrCustomerReviewText') ?? document.querySelector('[data-hook="total-review-count"]');
  const raw = textOf(el);
  // "12,438 ratings" -> 12438
  const m = /([0-9][0-9,.\s]*)/.exec(raw);
  if (!m) return 0;
  const digits = m[1]!.replace(/[^0-9]/g, '');
  if (!digits) return 0;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : 0;
}

// Soft cap so an adversarial page with thousands of <li> nodes cannot blow up
// memory or downstream prompt budgets. Real Amazon pages cap out well below 100.
const MAX_FEATURES = 100;

function parseFeatures(document: Document): string[] {
  const items = document.querySelectorAll('#feature-bullets ul li .a-list-item, #feature-bullets ul li span');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const el of Array.from(items)) {
    if (out.length >= MAX_FEATURES) break;
    const text = textOf(el as Element);
    if (!text) continue;
    if (text.length < 3) continue;
    // Skip "Make sure this fits" Amazon helper bullet.
    if (/make sure this fits/i.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseDescription(document: Document): string {
  const candidates = [
    document.querySelector('#productDescription'),
    document.querySelector('#bookDescription_feature_div #productDescription'),
    document.querySelector('#bookDescription_feature_div'),
    document.querySelector('#aplus'),
  ];
  for (const el of candidates) {
    const text = textOf(el);
    if (text && text.length >= 20) return text;
  }
  return '';
}

function readOverviewRow(document: Document, labelRe: RegExp): string {
  const rows = document.querySelectorAll('#productOverview_feature_div table tr');
  for (const row of Array.from(rows)) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) continue;
    const label = textOf(cells[0] as Element);
    if (labelRe.test(label)) {
      return textOf(cells[1] as Element);
    }
  }
  return '';
}

function parseOverviewSpecifications(document: Document): Record<string, string> {
  // Object.create(null) — the value labels come from attacker-controllable HTML,
  // so the container must not expose __proto__ / constructor as inherited slots.
  const out: Record<string, string> = Object.create(null);
  const rows = document.querySelectorAll('#productOverview_feature_div table tr');
  for (const row of Array.from(rows)) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) continue;
    const label = textOf(cells[0] as Element);
    const value = textOf(cells[1] as Element);
    if (!label || !value) continue;
    if (RESERVED_SPEC_KEY_RE.test(label)) continue;
    out[label] = value;
  }
  return out;
}

function parseDetailBulletSpecifications(document: Document): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const items = document.querySelectorAll('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li');
  for (const li of Array.from(items)) {
    const raw = textOf(li as Element);
    // Amazon renders these as: "ASIN ‍ : ‍ B08N5WRWNW"
    // After collapsing whitespace and stripping zero-width joiners, we get
    // "ASIN : B08N5WRWNW".
    const cleaned = raw.replace(/[‍‎‏​]/g, '').trim();
    const m = /^([^:]+?)\s*:\s*(.+)$/.exec(cleaned);
    if (!m) continue;
    const key = m[1]!.trim();
    const value = m[2]!.trim();
    if (!key || !value) continue;
    if (RESERVED_SPEC_KEY_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function parseSpecifications(document: Document): Record<string, string> {
  // Merge into a null-prototype object so spread cannot reintroduce reserved
  // keys via the __proto__ setter on a plain literal.
  const merged: Record<string, string> = Object.create(null);
  const overview = parseOverviewSpecifications(document);
  for (const k of Object.keys(overview)) merged[k] = overview[k]!;
  const detail = parseDetailBulletSpecifications(document);
  for (const k of Object.keys(detail)) merged[k] = detail[k]!;
  return merged;
}

function parseImages(document: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const url = raw.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (TRACKING_IMAGE_HINTS.some((h) => url.includes(h))) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  const hero = document.querySelector('#imgTagWrapperId img, #landingImage');
  if (hero) {
    push(hero.getAttribute('data-old-hires'));
    push(hero.getAttribute('src'));
  }

  const altImages = document.querySelectorAll('#altImages img, #imageBlock img, #imageBlock_feature_div img');
  for (const img of Array.from(altImages)) {
    push(img.getAttribute('src'));
    push(img.getAttribute('data-old-hires'));
  }

  return out;
}

function parseAvailability(document: Document): string {
  const el = document.querySelector('#availability');
  if (!el) return 'unknown';
  const text = textOf(el).toLowerCase();
  if (!text) return 'unknown';

  if (/pre-?order/.test(text)) return 'preorder';
  // Check OOS phrases first — "back in stock" inside an OOS notice must not
  // be misread as "in stock".
  if (/currently unavailable|out of stock|temporarily out of stock|sold out/.test(text)) return 'out_of_stock';
  if (/in stock/.test(text)) return 'in_stock';
  if (/usually ships|ships in/.test(text)) return 'in_stock';
  if (/only\s+\d+\s+left/.test(text)) return 'in_stock';

  // Heuristic by class: success colour = in stock, price colour = OOS.
  if (el.querySelector('.a-color-success')) return 'in_stock';
  if (el.querySelector('.a-color-price')) return 'out_of_stock';

  return 'unknown';
}

export function extractAmazonProduct(html: string, url: string): AmazonProduct | null {
  if (!html) return null;

  let document: Document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return null;
  }

  const title = parseTitle(document);
  if (!title) return null;

  const asinFromUrl = parseAsinFromUrl(url);
  const asin = asinFromUrl ?? parseAsinFromDom(document) ?? '';

  const { price, currency } = parsePriceAndCurrency(document);

  return {
    asin,
    title,
    brand: parseBrand(document),
    price,
    currency,
    rating: parseRating(document),
    review_count: parseReviewCount(document),
    description: parseDescription(document),
    features: parseFeatures(document),
    specifications: parseSpecifications(document),
    images: parseImages(document),
    availability: parseAvailability(document),
  };
}

function renderMarkdown(p: AmazonProduct): string {
  const lines: string[] = [`# ${p.title}`];

  if (p.brand) lines.push('', `**Brand:** ${p.brand}`);
  if (p.asin) lines.push(`**ASIN:** ${p.asin}`);

  if (p.price !== null) {
    const formatted = p.currency ? `${p.currency} ${p.price.toFixed(2)}` : p.price.toFixed(2);
    lines.push(`**Price:** ${formatted}`);
  } else {
    lines.push(`**Price:** unavailable`);
  }

  if (p.rating > 0) {
    lines.push(`**Rating:** ${p.rating} (${p.review_count} reviews)`);
  }

  if (p.availability) lines.push(`**Availability:** ${p.availability}`);

  if (p.features.length > 0) {
    lines.push('', '## Features');
    for (const f of p.features) lines.push(`- ${f}`);
  }

  if (p.description) {
    lines.push('', '## Description', '', p.description);
  }

  const specEntries = Object.entries(p.specifications);
  if (specEntries.length > 0) {
    lines.push('', '## Specifications');
    for (const [k, v] of specEntries) lines.push(`- **${k}:** ${v}`);
  }

  return lines.join('\n').trim();
}

export const amazonExtractor: Extractor = {
  name: 'amazon',

  canHandle(url: string): boolean {
    try {
      const u = new URL(url);
      if (!isAmazonHost(u.hostname)) return false;
      // Short-link domains don't expose a product path until they redirect —
      // accept on host alone so the fetch tier can resolve them.
      const host = u.hostname.toLowerCase();
      if (host === 'amzn.to' || host === 'a.co' || host.endsWith('.amzn.to') || host.endsWith('.a.co')) {
        return true;
      }
      return isProductPath(u.pathname);
    } catch {
      return false;
    }
  },

  extract(html: string, url: string): ExtractionResult | null {
    // Refuse to produce site_data when the body is a known
    // anti-bot / page-not-found landing. The caller learns about this via
    // the fetch envelope's fetch_failed="blocked" surface (set in routed.ts).
    if (detectAntiBotBlock(html)) return null;
    const product = extractAmazonProduct(html, url);
    if (!product) return null;

    const markdown = renderMarkdown(product);
    const metadata: ExtractionResult['metadata'] = {};
    if (product.description) metadata.description = product.description;
    if (product.images[0]) metadata.og_image = product.images[0];

    return {
      title: product.title,
      markdown,
      metadata,
      links: [],
      images: product.images,
      extractor: 'site-specific',
      // Structured product record threaded outward so routedExtract can surface
      // it on the FetchOutput without re-parsing the HTML a second time.
      site_data: product as unknown as Record<string, unknown>,
    };
  },
};
