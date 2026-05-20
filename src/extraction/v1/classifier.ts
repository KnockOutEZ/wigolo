import { parseHTML } from 'linkedom';
import { extractJsonLd } from '../jsonld.js';

export type ContentType = 'news' | 'recipe' | 'product' | 'code' | 'docs' | 'generic';

const JSONLD_TYPE_MAP: Record<string, ContentType> = {
  recipe: 'recipe',
  product: 'product',
  newsarticle: 'news',
  article: 'news',
  blogposting: 'news',
  question: 'code',
  answer: 'code',
  qapage: 'code',
  techarticle: 'docs',
  apireference: 'docs',
};

const OG_TYPE_MAP: Record<string, ContentType> = {
  article: 'news',
  product: 'product',
  recipe: 'recipe',
};

const DOCS_PATH_PREFIXES = ['/docs/', '/documentation/', '/reference/', '/api/'];

export function classifyContent(url: string, html: string): ContentType {
  const fromJsonLd = classifyByJsonLd(html);
  if (fromJsonLd) return fromJsonLd;

  const { document } = parseHTML(html || '<html></html>');

  const fromOg = classifyByOgType(document);
  if (fromOg) return fromOg;

  const fromHost = classifyByUrl(url);
  if (fromHost) return fromHost;

  const fromBody = classifyByBody(document);
  if (fromBody) return fromBody;

  return 'generic';
}

function classifyByJsonLd(html: string): ContentType | null {
  if (!html) return null;
  const blocks = extractJsonLd(html);
  for (const block of blocks) {
    const mapped = mapJsonLdType(block['@type']);
    if (mapped) return mapped;
  }
  return null;
}

function mapJsonLdType(raw: unknown): ContentType | null {
  if (typeof raw === 'string') {
    return JSONLD_TYPE_MAP[normalizeType(raw)] ?? null;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const mapped = JSONLD_TYPE_MAP[normalizeType(entry)];
      if (mapped) return mapped;
    }
  }
  return null;
}

function normalizeType(raw: string): string {
  // Accept "Recipe", "schema:Recipe", "http://schema.org/Recipe", etc.
  const tail = raw.split(/[/#:]/).pop() ?? raw;
  return tail.toLowerCase();
}

function classifyByOgType(document: Document): ContentType | null {
  const meta = document.querySelector('meta[property="og:type"]');
  const content = meta?.getAttribute('content')?.trim().toLowerCase();
  if (!content) return null;
  return OG_TYPE_MAP[content] ?? null;
}

function classifyByUrl(url: string): ContentType | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host === 'github.com' || host === 'gist.github.com' || host.endsWith('.github.com')) {
    return 'code';
  }
  if (host === 'stackoverflow.com' || host.endsWith('.stackoverflow.com')) {
    return 'code';
  }
  if (host.endsWith('.stackexchange.com') || host === 'stackexchange.com') {
    return 'code';
  }

  if (host === 'developer.mozilla.org' || host === 'devdocs.io') {
    return 'docs';
  }
  if (host.startsWith('docs.')) {
    return 'docs';
  }
  if (DOCS_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'docs';
  }

  return null;
}

function classifyByBody(document: Document): ContentType | null {
  const itemtypeNodes = document.querySelectorAll('[itemtype]');
  for (const node of itemtypeNodes) {
    const itemtype = node.getAttribute('itemtype')?.toLowerCase() ?? '';
    if (itemtype.includes('recipe')) return 'recipe';
    if (itemtype.includes('product')) return 'product';
  }

  const article = document.querySelector('article');
  if (article && article.querySelector('time[datetime]')) {
    return 'news';
  }

  return null;
}
