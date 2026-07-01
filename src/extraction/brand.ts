import { parseHTML } from 'linkedom';
import { createLogger } from '../logger.js';
import type { BrandExtractionOutput } from '../types.js';
import { extractJsonLd } from './jsonld.js';
import { extractPaletteFromBuffer, MAX_IMAGE_BYTES } from './brand-palette.js';
import { guardUrl } from '../watch/ssrf.js';

const log = createLogger('extract');

/** Total brand round-trip budget — spec target. Palette extraction must
 *  not push the call past this even when the logo fetch is slow. */
const PALETTE_FETCH_TIMEOUT_MS = 1500;

/** Minimum colors before palette extraction fires. CSS vars sometimes
 *  return 1 color; we still want a second so downstream UIs have a pair. */
const PALETTE_MIN_COLORS = 2;

type ProvenanceLogo = NonNullable<BrandExtractionOutput['provenance']>['logo'];
type ProvenanceColors = NonNullable<BrandExtractionOutput['provenance']>['colors'];
type ProvenanceFonts = NonNullable<BrandExtractionOutput['provenance']>['fonts'];

// CSS-vars-only color provenance. Palette extraction runs separately.
// `--brand-primary`, `--color-primary`, `--brand`, `--primary`, `--accent`,
// `--color-accent` are the dominant naming conventions in modern design
// systems (Tailwind, shadcn, Vercel design system, Linear, Stripe). Anchor
// the var name boundaries so `--brand-primary-foreground` doesn't sneak in
// as a true brand color.
const COLOR_VAR_PATTERNS: RegExp[] = [
  /--brand-primary(?:-\d+)?\b/i,
  /--color-primary(?:-\d+)?\b/i,
  /--primary(?:-\d+)?\b/i,
  /--brand(?:-\d+)?\b/i,
  /--accent(?:-\d+)?\b/i,
  /--color-accent(?:-\d+)?\b/i,
  /--theme-primary(?:-\d+)?\b/i,
];

// Hex / rgb(a) / hsl(a) / named — we keep hex + rgb only; named colors aren't
// branded distinctly and HSL gets normalized to hex when possible. Anchored
// to value boundaries so we don't grab var fallbacks like
// `var(--foo, #112233)` partial matches.
const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const RGB_RE = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)/g;
const HSL_RE = /hsla?\(\s*\d{1,3}(?:\.\d+)?\s*,?\s*\d{1,3}(?:\.\d+)?%\s*,?\s*\d{1,3}(?:\.\d+)?%(?:\s*[,/]\s*(?:0|1|0?\.\d+))?\s*\)/g;

// Social platform → (regex over href). Ordered by popularity in brand pages.
// Matches the visible-link-in-footer pattern most marketing sites use.
const SOCIAL_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: 'twitter', re: /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([^/?#]+)/i },
  { key: 'github', re: /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)/i },
  { key: 'linkedin', re: /^https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/([^/?#]+)/i },
  { key: 'youtube', re: /^https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|@)?([^/?#]+)/i },
  { key: 'discord', re: /^https?:\/\/(?:www\.)?discord\.(?:com|gg)\/(?:invite\/)?([^/?#]+)/i },
  { key: 'facebook', re: /^https?:\/\/(?:www\.)?facebook\.com\/([^/?#]+)/i },
  { key: 'instagram', re: /^https?:\/\/(?:www\.)?instagram\.com\/([^/?#]+)/i },
  { key: 'mastodon', re: /^https?:\/\/(?:[^./]+\.)*(?:mastodon|hachyderm|infosec|fosstodon)\.[^/]+\/@([^/?#]+)/i },
  { key: 'tiktok', re: /^https?:\/\/(?:www\.)?tiktok\.com\/@([^/?#]+)/i },
];

// Generic web fonts that show up in `font-family` declarations and don't
// represent a brand choice. Filter them out so callers see distinctive
// brand typography rather than fallback stacks.
const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  'apple-system', '-apple-system', 'blinkmacsystemfont',
  'segoe ui', 'roboto', 'helvetica neue', 'helvetica', 'arial',
  'sans', 'sans serif',
]);

// CSS custom property names that idiomatically carry the brand font.
const FONT_VAR_PATTERNS = {
  headings: [
    /--font-(?:heading|headings|display|brand|title|serif)\b/i,
  ],
  body: [
    /--font-(?:body|sans|base|primary|text)\b/i,
  ],
};

/** True when the URL's PATH ends in `.svg`, ignoring querystring/fragment.
 *  Used to skip the palette fetch for SVG logos — they're XML, not raster,
 *  so quantization can't use them. A raw-string `.endsWith('.svg')` would
 *  miss `…/logo.svg?v=2` and equivalent cache-busted forms. */
function isSvgPath(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg');
  } catch {
    // Malformed URL — fall through to the post-fetch MIME check.
    return false;
  }
}

function safeAbsoluteUrl(value: string | null | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Avoid javascript: / mailto: / data: / file: / vbscript: / blob: which
  // never resolve to a fetchable brand asset and can be abused by a
  // downstream auto-fetcher (e.g. file:///etc/passwd local exfil).
  if (/^(javascript|mailto|tel|data|file|vbscript|blob):/i.test(trimmed)) return undefined;
  try {
    if (baseUrl) return new URL(trimmed, baseUrl).href;
    // No base — accept only absolute URLs.
    return new URL(trimmed).href;
  } catch {
    return undefined;
  }
}

function getMeta(doc: Document, nameOrProperty: string): string | undefined {
  const el =
    doc.querySelector(`meta[name="${nameOrProperty}"]`) ??
    doc.querySelector(`meta[property="${nameOrProperty}"]`);
  const content = el?.getAttribute('content') ?? undefined;
  return content && content.trim().length > 0 ? content.trim() : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// Recursively walk a JSON-LD block looking for a node matching `@type`.
// Returns the first match; `Organization`, `Brand`, `WebSite`, `LocalBusiness`,
// `Corporation` are the relevant carriers of brand information.
function findJsonLdNode(
  blocks: Record<string, unknown>[],
  types: string[],
): Record<string, unknown> | undefined {
  const wantedLower = new Set(types.map((t) => t.toLowerCase()));

  function visit(node: unknown): Record<string, unknown> | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item);
        if (hit) return hit;
      }
      return undefined;
    }
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    if (typeof type === 'string' && wantedLower.has(type.toLowerCase())) return obj;
    if (Array.isArray(type)) {
      for (const t of type) {
        if (typeof t === 'string' && wantedLower.has(t.toLowerCase())) return obj;
      }
    }
    for (const v of Object.values(obj)) {
      const hit = visit(v);
      if (hit) return hit;
    }
    return undefined;
  }

  for (const block of blocks) {
    const hit = visit(block);
    if (hit) return hit;
  }
  return undefined;
}

// JSON-LD `logo` can be a string or an ImageObject `{ url }`. Same for
// `image`. Normalize both.
function jsonLdImageUrl(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const url = jsonLdImageUrl(v);
      if (url) return url;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const url = obj.url ?? obj['@id'] ?? obj.contentUrl;
    if (typeof url === 'string') return url;
  }
  return undefined;
}

interface JsonLdBrand {
  name?: string;
  description?: string;
  logo?: string;
  socialLinks: string[];
  source: 'json-ld' | 'unknown';
}

function extractFromJsonLd(blocks: Record<string, unknown>[]): JsonLdBrand {
  const out: JsonLdBrand = { socialLinks: [], source: 'unknown' };
  const node = findJsonLdNode(blocks, [
    'Organization',
    'Corporation',
    'LocalBusiness',
    'Brand',
    'WebSite',
  ]);
  if (!node) return out;

  out.source = 'json-ld';

  if (typeof node.name === 'string') out.name = node.name.trim();
  if (typeof node.description === 'string') out.description = node.description.trim();
  if (typeof node.slogan === 'string' && !out.description) {
    out.description = node.slogan.trim();
  }

  const logo = jsonLdImageUrl(node.logo) ?? jsonLdImageUrl(node.image);
  if (logo) out.logo = logo;

  // schema.org carries social profiles in `sameAs` (string or string[]).
  const sameAs = node.sameAs;
  if (typeof sameAs === 'string') out.socialLinks.push(sameAs);
  else if (Array.isArray(sameAs)) {
    for (const s of sameAs) {
      if (typeof s === 'string') out.socialLinks.push(s);
    }
  }

  return out;
}

interface OgBrand {
  name?: string;
  description?: string;
  tagline?: string;
  ogImage?: string;
  ogLogo?: string;
  twitterHandle?: string;
}

function extractFromOg(doc: Document): OgBrand {
  const out: OgBrand = {};

  const siteName = getMeta(doc, 'og:site_name');
  if (siteName) out.name = siteName;

  const description = firstNonEmpty(
    getMeta(doc, 'og:description'),
    getMeta(doc, 'twitter:description'),
    getMeta(doc, 'description'),
  );
  if (description) out.description = description;

  // `og:title` on the homepage typically reads like a tagline; we keep it
  // separate so callers can disambiguate from `name`.
  const ogTitle = getMeta(doc, 'og:title');
  if (ogTitle && ogTitle !== siteName) out.tagline = ogTitle;

  const ogImage = firstNonEmpty(
    getMeta(doc, 'og:image'),
    getMeta(doc, 'og:image:secure_url'),
    getMeta(doc, 'twitter:image'),
    getMeta(doc, 'twitter:image:src'),
  );
  if (ogImage) out.ogImage = ogImage;

  // `og:logo` is non-standard but used by enough sites (Stripe being one)
  // to be worth probing.
  const ogLogo = firstNonEmpty(
    getMeta(doc, 'og:logo'),
    getMeta(doc, 'twitter:logo'),
  );
  if (ogLogo) out.ogLogo = ogLogo;

  const twitterSite = firstNonEmpty(
    getMeta(doc, 'twitter:site'),
    getMeta(doc, 'twitter:creator'),
  );
  if (twitterSite) {
    out.twitterHandle = twitterSite.replace(/^@/, '');
  }

  return out;
}

interface IconResult {
  url: string;
  source: 'link[rel=icon]';
}

// Prefer the highest-resolution / SVG icon when multiple are declared. SVG
// trumps PNG; otherwise pick the largest declared size. Falls back to the
// generic favicon.ico relative to the document URL.
function extractFavicon(doc: Document, baseUrl: string | undefined): IconResult | undefined {
  const candidates = Array.from(
    doc.querySelectorAll(
      'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]',
    ),
  );

  let best: { url: string; weight: number } | undefined;
  for (const el of candidates) {
    const href = el.getAttribute('href');
    const resolved = safeAbsoluteUrl(href, baseUrl);
    if (!resolved) continue;

    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const sizes = (el.getAttribute('sizes') ?? '').toLowerCase();
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();

    // Weighting: SVG > apple-touch (180x180) > biggest declared size > any.
    let weight = 1;
    if (type.includes('svg') || resolved.endsWith('.svg')) weight = 1000;
    else if (rel.includes('apple-touch-icon')) weight = 180;
    else if (sizes === 'any') weight = 256;
    else {
      const m = sizes.match(/(\d+)x\1/) ?? sizes.match(/(\d+)x(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) weight = n;
      }
    }

    if (!best || weight > best.weight) {
      best = { url: resolved, weight };
    }
  }

  if (best) return { url: best.url, source: 'link[rel=icon]' };

  // Last-resort favicon at root. Many sites still serve /favicon.ico without
  // a declared <link>. Only emit when we have a base URL to resolve against.
  if (baseUrl) {
    try {
      const root = new URL('/favicon.ico', baseUrl).href;
      return { url: root, source: 'link[rel=icon]' };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface HeuristicLogo {
  url?: string;
  alt?: string;
}

// Marketing headers consistently put the logo behind one of these patterns:
//   <a href="/"><img src="..." alt="Stripe"></a>
//   <a class="logo">…</a>
//   <header> <img alt="Logo" …>
// We probe in order of specificity to avoid grabbing a hero illustration.
function extractHeuristicLogo(doc: Document, baseUrl: string | undefined): HeuristicLogo {
  const out: HeuristicLogo = {};

  const selectors = [
    'header a[href="/"] img',
    'header [class*="logo" i] img',
    'header img[class*="logo" i]',
    '[class*="navbar" i] a[href="/"] img',
    '[class*="navbar" i] [class*="logo" i] img',
    '[class*="header" i] [class*="logo" i] img',
    'a[aria-label*="home" i] img',
    'a[href="/"] img[alt]',
    '[class*="logo" i] img',
    'img[class*="logo" i]',
    'img[alt*="logo" i]',
  ];

  for (const sel of selectors) {
    try {
      const img = doc.querySelector(sel);
      if (!img) continue;
      const src =
        img.getAttribute('src') ??
        img.getAttribute('data-src') ??
        img.getAttribute('data-lazy-src') ??
        img.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
      const resolved = safeAbsoluteUrl(src, baseUrl);
      if (!resolved) continue;
      out.url = resolved;
      const alt = img.getAttribute('alt');
      if (alt) out.alt = alt.trim();
      return out;
    } catch {
      // selector parse errors on hostile DOM — skip
    }
  }

  // SVG logos sometimes have no <img>; check for an inline <svg> inside a
  // logo-classed container so we can at least surface the brand name from
  // aria-label.
  const inlineLogo = doc.querySelector('header [class*="logo" i] svg, [class*="navbar" i] [class*="logo" i] svg');
  if (inlineLogo) {
    const ariaLabel = inlineLogo.getAttribute('aria-label') ?? inlineLogo.querySelector('title')?.textContent;
    if (ariaLabel) out.alt = ariaLabel.trim();
  }

  return out;
}

interface SocialLinks {
  [platform: string]: string;
}

function categorizeSocial(url: string): { key: string; canonical: string } | undefined {
  for (const { key, re } of SOCIAL_PATTERNS) {
    if (re.test(url)) {
      // Normalize trailing slashes and strip query strings — social handles
      // are identity-bearing, query params aren't.
      const m = url.match(re);
      const handle = m ? m[1].replace(/\/$/, '') : undefined;
      // Reconstruct a canonical URL form so callers get a stable identifier.
      switch (key) {
        case 'twitter':
          return handle ? { key, canonical: `https://twitter.com/${handle}` } : undefined;
        case 'github':
          return handle ? { key, canonical: `https://github.com/${handle}` } : undefined;
        case 'linkedin':
          return { key, canonical: url.replace(/\?.*$/, '').replace(/\/$/, '') };
        default:
          return { key, canonical: url.replace(/\?.*$/, '').replace(/\/$/, '') };
      }
    }
  }
  return undefined;
}

function extractSocialLinks(
  doc: Document,
  baseUrl: string | undefined,
  twitterHandle?: string,
  extraUrls: string[] = [],
): SocialLinks {
  const out: SocialLinks = {};
  const seen = new Set<string>();

  function ingest(url: string | undefined) {
    if (!url) return;
    const absolute = safeAbsoluteUrl(url, baseUrl);
    if (!absolute) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const cat = categorizeSocial(absolute);
    if (!cat) return;
    // First-wins: don't overwrite a JSON-LD-supplied handle with a footer link.
    if (out[cat.key]) return;
    out[cat.key] = cat.canonical;
  }

  // Hoist anchors first so explicit links beat the twitter:site meta below.
  const anchors = doc.querySelectorAll('a[href]');
  for (const a of anchors) {
    ingest(a.getAttribute('href') ?? undefined);
  }

  for (const u of extraUrls) {
    ingest(u);
  }

  // twitter:site / twitter:creator carry a handle, not a full URL — derive.
  if (twitterHandle && !out.twitter) {
    const canon = `https://twitter.com/${twitterHandle.replace(/^@/, '')}`;
    out.twitter = canon;
  }

  return out;
}

function normalizeHex(hex: string): string | undefined {
  let h = hex.replace('#', '').toLowerCase();
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  } else if (h.length === 4) {
    // #rgba — drop alpha for palette comparison
    h = h.slice(0, 3).split('').map((c) => c + c).join('');
  } else if (h.length === 8) {
    h = h.slice(0, 6);
  } else if (h.length !== 6) {
    return undefined;
  }
  if (!/^[0-9a-f]{6}$/.test(h)) return undefined;
  return `#${h}`;
}

function rgbToHex(rgb: string): string | undefined {
  const m = rgb.match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map((s) => parseInt(s, 10));
  if (![r, g, b].every((n) => n >= 0 && n <= 255)) return undefined;
  return (
    '#' +
    [r, g, b]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
  );
}

function hslToHex(hsl: string): string | undefined {
  const m = hsl.match(/(\d{1,3}(?:\.\d+)?)\s*,?\s*(\d{1,3}(?:\.\d+)?)%\s*,?\s*(\d{1,3}(?:\.\d+)?)%/);
  if (!m) return undefined;
  const h = parseFloat(m[1]) % 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  if (![h, s, l].every(Number.isFinite)) return undefined;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m2 = l - c / 2;
  const toByte = (n: number) =>
    Math.max(0, Math.min(255, Math.round((n + m2) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function parseColorToHex(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('#')) return normalizeHex(trimmed);
  if (trimmed.startsWith('rgb')) return rgbToHex(trimmed);
  if (trimmed.startsWith('hsl')) return hslToHex(trimmed);
  return undefined;
}

// Pull every inline <style> block plus same-origin linked stylesheet
// `<link rel="stylesheet">` whose `href` we have an inline copy of via
// `<style data-href="...">` (rare). For real stylesheets, the caller would
// need to fetch them — that's outside B2a scope. We surface only what's in
// the document.
function collectInlineCss(doc: Document): string {
  const blocks: string[] = [];
  for (const style of doc.querySelectorAll('style')) {
    const text = style.textContent;
    if (text) blocks.push(text);
  }
  // Inline `style` attributes can also carry colors (small but useful for
  // sites that put a brand color on the body element).
  for (const el of doc.querySelectorAll('[style]')) {
    const text = el.getAttribute('style');
    if (text) blocks.push(text);
  }
  return blocks.join('\n');
}

/** `<style>` block content only — no inline-style attributes. Font extraction
 *  needs to distinguish a CSS-rule selector (`body { font-family: … }`) from
 *  a style attribute on a body element; mixing them defeats provenance. */
function collectStyleBlockCss(doc: Document): string {
  const blocks: string[] = [];
  for (const style of doc.querySelectorAll('style')) {
    const text = style.textContent;
    if (text) blocks.push(text);
  }
  return blocks.join('\n');
}

interface ColorResult {
  colors: string[];
  source: ProvenanceColors;
}

function extractColorsFromCss(css: string): ColorResult {
  if (!css) return { colors: [], source: 'unknown' };

  // Two-phase strategy:
  // 1. Find CSS-var declarations whose name matches our brand-color patterns.
  // 2. Resolve each var to its hex/rgb/hsl literal.
  // We also accept color literals declared directly on `:root` even when the
  // var name isn't in our list — when the literal lives in a block that
  // contains an obvious brand-named var, the rule of "colors near brand
  // vars" is a strong signal.
  const found: string[] = [];
  const seen = new Set<string>();

  // Scan declarations like: --brand-primary: #635bff;
  const declRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;}]+)[;}]/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(css)) !== null) {
    const name = match[1];
    const value = match[2].trim();
    const nameMatches = COLOR_VAR_PATTERNS.some((re) => re.test(name));
    if (!nameMatches) continue;

    // Value may be a literal, or `var(--other, fallback)` — try both.
    const literal = parseColorToHex(value);
    if (literal && !seen.has(literal)) {
      seen.add(literal);
      found.push(literal);
      continue;
    }

    // Fallback inside var(): var(--whatever, #abcdef)
    const fallback = value.match(/var\([^,)]+,\s*([^)]+)\)/);
    if (fallback) {
      const hex = parseColorToHex(fallback[1]);
      if (hex && !seen.has(hex)) {
        seen.add(hex);
        found.push(hex);
      }
      continue;
    }

    // HSL declarations sometimes split across three numbers without the
    // `hsl()` wrapper (Tailwind/shadcn style: `--primary: 240 5.9% 10%`).
    const tripleHsl = value.match(/^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/);
    if (tripleHsl) {
      const synthetic = `hsl(${tripleHsl[1]}, ${tripleHsl[2]}%, ${tripleHsl[3]}%)`;
      const hex = hslToHex(synthetic);
      if (hex && !seen.has(hex)) {
        seen.add(hex);
        found.push(hex);
      }
    }
  }

  return found.length > 0
    ? { colors: found, source: 'css-vars' }
    : { colors: [], source: 'unknown' };
}

interface FontResult {
  headings: string[];
  body: string[];
  source: ProvenanceFonts;
}

function splitFontFamilyList(value: string): string[] {
  return value
    .split(',')
    .map((s) =>
      s
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/!important$/, '')
        .trim(),
    )
    .filter((s) => s.length > 0 && !GENERIC_FONTS.has(s.toLowerCase()));
}

/** Parse `font-family:` from a raw inline-style attribute value. Returns the
 *  brand-only family list (generics stripped). */
function fontsFromStyleAttr(styleAttr: string | null | undefined): string[] {
  if (!styleAttr) return [];
  const m = styleAttr.match(/font-family\s*:\s*([^;]+)/i);
  if (!m) return [];
  return splitFontFamilyList(m[1]);
}

/** Source 1 — CSS custom properties (`--font-heading`, `--font-body`, …).
 *  Strongest signal: an explicit declaration that names the brand font. */
function fontsFromCssVars(cssText: string): { headings: string[]; body: string[] } {
  const headings = new Set<string>();
  const body = new Set<string>();
  if (!cssText) return { headings: [], body: [] };

  const declRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;}]+)[;}]/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(cssText)) !== null) {
    const name = m[1];
    const value = m[2].trim();
    if (FONT_VAR_PATTERNS.headings.some((re) => re.test(name))) {
      for (const f of splitFontFamilyList(value)) headings.add(f);
    } else if (FONT_VAR_PATTERNS.body.some((re) => re.test(name))) {
      for (const f of splitFontFamilyList(value)) body.add(f);
    }
  }
  return { headings: Array.from(headings), body: Array.from(body) };
}

/** Source 2 — `<style>` block rules targeting `body { font-family: … }` or
 *  `h1, h2 { font-family: … }`. Distinct from inline-style ATTRIBUTES on
 *  individual elements (see `fontsFromInlineStyleAttrs`). */
function fontsFromCssRules(cssText: string): { headings: string[]; body: string[] } {
  const headings = new Set<string>();
  const body = new Set<string>();
  if (!cssText) return { headings: [], body: [] };

  // Walk rule blocks so we can attribute font-family to headings vs body
  // based on the selector. `{[^{}]+}` keeps nested blocks (e.g. @media)
  // out of scope — handling them needs a proper parser, which is overkill
  // for brand extraction.
  const ruleRe = /([^{}]+)\{([^{}]+)\}/g;
  let r: RegExpExecArray | null;
  while ((r = ruleRe.exec(cssText)) !== null) {
    const selectorList = r[1].trim().toLowerCase();
    const decls = r[2];
    const ff = decls.match(/font-family\s*:\s*([^;}]+)/i);
    if (!ff) continue;
    const families = splitFontFamilyList(ff[1]);
    if (families.length === 0) continue;

    // A rule may target multiple selectors; check each independently so
    // `h1, h2, p { … }` lands the family in BOTH buckets.
    const selectors = selectorList.split(',').map((s) => s.trim());
    for (const selector of selectors) {
      const isHeading = /\b(h[1-6]|heading|title|display)\b/.test(selector);
      const isBody =
        /\b(body|html|p|main|article|prose)\b/.test(selector) ||
        selector === ':root' ||
        selector === '*';
      if (isHeading) {
        for (const f of families) headings.add(f);
      } else if (isBody) {
        for (const f of families) body.add(f);
      }
    }
  }
  return { headings: Array.from(headings), body: Array.from(body) };
}

/** Source 3 — `style="font-family: …"` attribute on `<h1>`/`<h2>`/`<body>`.
 *  Figma uses this; some older marketing templates do too. */
function fontsFromInlineStyleAttrs(doc: Document): { headings: string[]; body: string[] } {
  const headings = new Set<string>();
  const body = new Set<string>();

  for (const heading of doc.querySelectorAll('h1[style], h2[style]')) {
    for (const f of fontsFromStyleAttr(heading.getAttribute('style'))) {
      headings.add(f);
    }
  }
  const bodyEl = doc.querySelector('body[style]');
  if (bodyEl) {
    for (const f of fontsFromStyleAttr(bodyEl.getAttribute('style'))) {
      body.add(f);
    }
  }
  return { headings: Array.from(headings), body: Array.from(body) };
}

/** Source 4 — Google Fonts `<link>` stylesheet. Returns each `family=` value
 *  in order. The Google Fonts API supports both:
 *    /css?family=Inter:400,700
 *    /css2?family=Playfair+Display:wght@700&family=Inter:wght@400
 *  In both, family names use `+` for spaces and `:` separates weights/axes. */
function fontsFromGoogleFontsLinks(doc: Document): string[] {
  const families: string[] = [];
  const seen = new Set<string>();

  for (const link of doc.querySelectorAll('link[href]')) {
    const href = link.getAttribute('href') ?? '';
    // Match both the v1 (`/css?…`) and v2 (`/css2?…`) endpoints. We also
    // accept `https://` and `//`-protocol-relative forms (common on
    // older sites that pre-date HTTPS-first hosting).
    if (!/(^|\/\/)fonts\.googleapis\.com\/(css|css2)\?/.test(href)) continue;

    // Pull every family=… query parameter. URLSearchParams is friendlier
    // than hand-rolling a parser, but we need a hostname to construct a
    // URL — guard against malformed hrefs.
    let url: URL;
    try {
      url = new URL(href, 'https://fonts.googleapis.com/');
    } catch {
      continue;
    }
    for (const raw of url.searchParams.getAll('family')) {
      // family value looks like `Inter:wght@400;700` or `Playfair+Display:700,400`.
      // The family NAME is everything before the first `:` (axis specifier).
      const namePart = raw.split(':')[0];
      // Google Fonts uses `+` for spaces in family names.
      const name = namePart.replace(/\+/g, ' ').trim();
      if (!name) continue;
      if (GENERIC_FONTS.has(name.toLowerCase())) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      families.push(name);
    }
  }
  return families;
}

/** Combined font extraction. Priority order — first source with ≥1 family
 *  wins; sources are NOT merged so callers always know which signal won.
 *
 *  1. CSS custom properties (`--font-heading` / `--font-body`)
 *  2. `<style>` block rules (`body { … }`, `h1, h2 { … }`)
 *  3. Inline `style=` attribute on `<h1>` / `<h2>` / `<body>`
 *  4. Google Fonts `<link>` stylesheets
 *
 *  When the only source is Google Fonts and a single family is listed, the
 *  family is assigned to BOTH headings and body — most sites use a single
 *  brand font for everything. When multiple families are listed, the first
 *  becomes headings and the second becomes body (matches typical link-tag
 *  ordering on marketing pages).
 */
function extractFonts(doc: Document, styleBlockCss: string): FontResult {
  // Source 1 — CSS vars
  const cssVars = fontsFromCssVars(styleBlockCss);
  if (cssVars.headings.length > 0 || cssVars.body.length > 0) {
    return {
      headings: cssVars.headings.slice(0, 5),
      body: cssVars.body.slice(0, 5),
      source: 'css-vars',
    };
  }

  // Source 2 — <style> block CSS rules
  const cssRules = fontsFromCssRules(styleBlockCss);
  if (cssRules.headings.length > 0 || cssRules.body.length > 0) {
    return {
      headings: cssRules.headings.slice(0, 5),
      body: cssRules.body.slice(0, 5),
      source: 'css-rule',
    };
  }

  // Source 3 — inline style attributes on h1/h2/body
  const inline = fontsFromInlineStyleAttrs(doc);
  if (inline.headings.length > 0 || inline.body.length > 0) {
    return {
      headings: inline.headings.slice(0, 5),
      body: inline.body.slice(0, 5),
      source: 'inline-style',
    };
  }

  // Source 4 — Google Fonts <link>
  const googleFonts = fontsFromGoogleFontsLinks(doc);
  if (googleFonts.length > 0) {
    const headings: string[] = [];
    const body: string[] = [];
    if (googleFonts.length === 1) {
      // Single family — most sites use one font everywhere.
      headings.push(googleFonts[0]);
      body.push(googleFonts[0]);
    } else {
      // First family → headings, second → body. Remaining surface only
      // as headings to preserve order; we cap at 5 either side.
      headings.push(googleFonts[0]);
      body.push(googleFonts[1]);
      for (let i = 2; i < googleFonts.length; i++) headings.push(googleFonts[i]);
    }
    return {
      headings: headings.slice(0, 5),
      body: body.slice(0, 5),
      source: 'google-fonts-link',
    };
  }

  return { headings: [], body: [], source: 'unknown' };
}

/** Back-compat wrapper kept for `__internal` consumers. Operates on a CSS
 *  blob (no DOM) and therefore can't run the inline-attribute or Google
 *  Fonts paths — those need the live document. */
function extractFontsFromCss(css: string): FontResult {
  const cssVars = fontsFromCssVars(css);
  if (cssVars.headings.length > 0 || cssVars.body.length > 0) {
    return {
      headings: cssVars.headings.slice(0, 5),
      body: cssVars.body.slice(0, 5),
      source: 'css-vars',
    };
  }
  const cssRules = fontsFromCssRules(css);
  if (cssRules.headings.length > 0 || cssRules.body.length > 0) {
    return {
      headings: cssRules.headings.slice(0, 5),
      body: cssRules.body.slice(0, 5),
      source: 'css-rule',
    };
  }
  return { headings: [], body: [], source: 'unknown' };
}

export interface BrandImageFetchResult {
  buffer: Buffer;
  contentType: string;
}

export type BrandImageFetcher = (
  url: string,
  options?: { timeoutMs?: number },
) => Promise<BrandImageFetchResult | null>;

export interface ExtractBrandOptions {
  /** Base URL for resolving relative href/src; usually the page URL. */
  baseUrl?: string;
  /**
   * When provided, this fetcher is used to download logo/og_image bytes
   * for palette extraction. Defaults to a small wrapper over
   * the existing `httpFetch` helper so cache + UA rotation + retries are
   * reused. Pass a mock in tests to keep the suite hermetic.
   *
   * Set to `null` to explicitly disable palette extraction (useful for
   * callers that have an already-passing CSS-var color result and want to
   * skip the network round-trip).
   */
  imageFetcher?: BrandImageFetcher | null;
}

/** Maximum 3xx hops the image fetcher will follow before giving up. Open
 *  redirects chained beyond this are a strong signal of intentional abuse. */
const MAX_REDIRECT_HOPS = 3;

/**
 * Default image fetcher. We can't reuse `httpFetch` directly because it
 * decodes the response body via `response.text()`, which corrupts binary
 * bytes — fine for HTML, fatal for PNG/JPEG. We do a single HEAD-like
 * round-trip via the same Node-built-in `fetch` that `httpFetch` uses
 * under the hood, applying the same timeout discipline.
 *
 * SSRF safety lives HERE — not upstream. The URL we receive comes from
 * `safeAbsoluteUrl()`, which only filters dangerous schemes
 * (`javascript:`/`data:`/`file:`/`blob:`/`vbscript:`). That leaves
 * loopback (`http://127.0.0.1/`), RFC 1918 (`http://10.0.0.1/`),
 * link-local AWS metadata (`http://169.254.169.254/`), and IPv6 private
 * ranges wide open — a malicious page's JSON-LD logo could otherwise
 * force the server to make a request on its behalf. We apply `guardUrl`
 * BEFORE the first fetch and re-validate on every 3xx hop.
 *
 * Redirects are handled manually (`redirect: 'manual'`). A naive
 * `redirect: 'follow'` would let Node's fetch transparently chase a
 * 302 → 127.0.0.1, bypassing the guard. Each hop is re-validated; chains
 * cap at `MAX_REDIRECT_HOPS` to prevent open-redirect chain abuse.
 *
 * Streaming + early-abort when content-length signals an oversize body
 * keeps the bandwidth honest: the spec's 2s round-trip budget assumes
 * we don't pull a 50MB hero image just to throw it away.
 */
export const defaultImageFetcher: BrandImageFetcher = async (url, opts) => {
  const timeoutMs = opts?.timeoutMs ?? PALETTE_FETCH_TIMEOUT_MS;
  // Single shared deadline across the redirect chain — chained hops cannot
  // smuggle around the budget by spinning out the abort signal each hop.
  const signal = AbortSignal.timeout(timeoutMs);

  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const guard = guardUrl(currentUrl, 'image_url');
    if (!guard.ok) {
      log.debug('palette fetch: SSRF guard rejected URL', {
        url: currentUrl,
        reason: guard.reason,
        hop,
      });
      return null;
    }

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: {
          Accept: 'image/png,image/jpeg,image/webp,image/avif,image/*;q=0.8',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        },
        signal,
        redirect: 'manual',
      });
    } catch (err) {
      log.debug('palette fetch failed', { url: currentUrl, error: String(err) });
      return null;
    }

    // 3xx — drain body, resolve Location against currentUrl, loop.
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* drop */ }
      const location = response.headers.get('location');
      if (!location) {
        log.debug('palette fetch: 3xx without Location header', {
          url: currentUrl,
          status: response.status,
        });
        return null;
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        log.debug('palette fetch: unresolvable Location header', {
          url: currentUrl,
          location,
        });
        return null;
      }
      if (hop === MAX_REDIRECT_HOPS) {
        log.debug('palette fetch: too many redirects', { url, hops: hop + 1 });
        return null;
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      log.debug('palette fetch: non-2xx', { url: currentUrl, status: response.status });
      return null;
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
      log.debug('palette fetch: content-length over cap', { url: currentUrl, contentLength });
      try { await response.body?.cancel(); } catch { /* */ }
      return null;
    }
    const ab = await response.arrayBuffer();
    if (ab.byteLength > MAX_IMAGE_BYTES) {
      log.debug('palette fetch: body over cap', { url: currentUrl, bytes: ab.byteLength });
      return null;
    }
    return {
      buffer: Buffer.from(ab),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
  // Unreachable — the loop either returns or breaks via the redirect cap.
  return null;
};

/**
 * Async brand extraction. Runs the synchronous extractor first,
 * then — when CSS-var colors come up short — fetches the logo/og_image and
 * runs palette quantization. Returns the augmented output with
 * `provenance.colors` set to `'palette-extraction'` when the image path
 * fires, `'unknown'` when the image fetch fails or no usable image exists.
 *
 * The synchronous `extractBrand` remains the canonical sync entry point.
 */
export async function extractBrandAsync(
  html: string,
  options: ExtractBrandOptions = {},
): Promise<BrandExtractionOutput> {
  const out = extractBrand(html, options);
  const fetcher = options.imageFetcher === undefined ? defaultImageFetcher : options.imageFetcher;
  if (fetcher === null) return out;

  const existing = out.primary_colors ?? [];
  if (existing.length >= PALETTE_MIN_COLORS) return out;

  // Pick the logo/og_image source. Logo is preferred — Organization-shape
  // color is most semantic. og_image_url is a fallback because it's often
  // a marketing hero shot, not a brand mark. We do NOT use favicon_url
  // here: favicons are typically too small to quantize meaningfully and
  // are usually monochrome.
  const candidate = out.logo_url ?? out.og_image_url;
  if (!candidate) {
    // Nothing to fetch; provenance stays as the sync extractor decided.
    return out;
  }

  // Reject SVG before spending the fetch budget — palette quantization
  // needs raster pixels. SVG logos are common; this short-circuit saves
  // the round-trip. We test the URL's `pathname` (not the raw string)
  // so `…/logo.svg?v=2` and other cache-busted forms still match. A
  // malformed URL falls through to the fetch path — the post-fetch MIME
  // guard in `extractPaletteFromBuffer` is the safety net there.
  if (isSvgPath(candidate)) {
    log.debug('palette: candidate is SVG, skipping image fetch', { url: candidate });
    return out;
  }

  const fetched = await fetcher(candidate, { timeoutMs: PALETTE_FETCH_TIMEOUT_MS });
  if (!fetched) {
    log.debug('palette: fetch returned null', { url: candidate });
    return out;
  }

  const palette = await extractPaletteFromBuffer(fetched.buffer, fetched.contentType);
  if (!palette || palette.colors.length < PALETTE_MIN_COLORS) {
    log.debug('palette: quantization produced insufficient colors', {
      url: candidate,
      colorCount: palette?.colors.length ?? 0,
    });
    return out;
  }

  // Replace primary_colors and flip provenance. We replace rather than
  // merge because CSS vars returned <2 — the image path is now the
  // authoritative source for this site's palette.
  out.primary_colors = palette.colors;
  if (out.provenance) {
    out.provenance.colors = 'palette-extraction';
  } else {
    out.provenance = { colors: 'palette-extraction' };
  }
  log.debug('palette extracted', { url: candidate, colors: palette.colors });
  return out;
}

export function extractBrand(
  html: string,
  options: ExtractBrandOptions = {},
): BrandExtractionOutput {
  const { document: doc } = parseHTML(html);
  const baseUrl = options.baseUrl;

  // 1. JSON-LD Organization / Brand / WebSite — strongest source.
  const jsonldBlocks = extractJsonLd(html);
  const jsonld = extractFromJsonLd(jsonldBlocks);

  // 2. OG + Twitter Card meta — second strongest, near-universal.
  const og = extractFromOg(doc);

  // 3. Favicon / apple-touch-icon links.
  const favicon = extractFavicon(doc, baseUrl);

  // 4. Heuristic DOM logo.
  const heuristicLogo = extractHeuristicLogo(doc, baseUrl);

  // Logo precedence: JSON-LD > og:logo > heuristic DOM.
  // Honesty contract (M3): favicons NEVER promote to logo. A favicon is a
  // 16x16 / 32x32 browser tab icon — surfacing it as `logo_url` makes
  // brand cards look like pixel soup. The favicon stays in `favicon_url`.
  let logoUrl: string | undefined;
  let logoProvenance: ProvenanceLogo = 'unknown';

  const jsonldLogo = safeAbsoluteUrl(jsonld.logo, baseUrl);
  const ogLogoUrl = safeAbsoluteUrl(og.ogLogo, baseUrl);
  const heuristicLogoUrl = heuristicLogo.url;

  if (jsonldLogo) {
    logoUrl = jsonldLogo;
    logoProvenance = 'json-ld';
  } else if (ogLogoUrl) {
    logoUrl = ogLogoUrl;
    logoProvenance = 'og:logo';
  } else if (heuristicLogoUrl) {
    logoUrl = heuristicLogoUrl;
    logoProvenance = 'heuristic';
  }
  // No fallback to favicon — that's a different field with its own provenance.

  // Name precedence: JSON-LD > og:site_name > heuristic alt text.
  // Honesty contract: the page <title> is NOT a name source. A title
  // like "Home \\ Anthropic" or "Build software faster | Acme" carries
  // the tagline first; splitting on " | " and using the prefix as `name`
  // gives tagline-as-name on Anthropic.com. When
  // no explicit name source exists, `name` stays undefined and the caller
  // can decide whether to render a placeholder.
  const titleRaw = doc.querySelector('title')?.textContent?.trim();
  const title = titleRaw && titleRaw.length > 0 ? titleRaw : undefined;

  const name = firstNonEmpty(jsonld.name, og.name, heuristicLogo.alt);

  // Tagline: og:title (when distinct from name) > <title> tail (only when
  // name is known and the title contains it — otherwise we can't isolate
  // the tail from the brand portion). Without a known name, we don't try
  // to split a title into "tail" — it could be the brand itself.
  let tagline: string | undefined = og.tagline;
  if (!tagline && title && name && title.includes(name)) {
    const parts = title.split(/\s+[|·—–-]\s+/);
    const tail = parts.slice(1).join(' — ').trim();
    if (tail && tail.toLowerCase() !== name.toLowerCase()) tagline = tail;
  }

  const description = firstNonEmpty(jsonld.description, og.description);

  // 5. Social links — collected from anchors plus sameAs from JSON-LD plus
  // twitter:site handle.
  const socialLinks = extractSocialLinks(doc, baseUrl, og.twitterHandle, jsonld.socialLinks);

  // 6. CSS var colors (B2a). Colors are mined from BOTH <style> blocks and
  // inline-style attributes (small color literals on the body element are
  // common in old templates).
  const css = collectInlineCss(doc);
  const colorResult = extractColorsFromCss(css);

  // 7. Font hints — priority chain across CSS vars, <style> rules, inline
  // style attrs, and Google Fonts links. Only <style> blocks feed the
  // CSS-rule + var paths because attribute-bearing selectors aren't
  // valid CSS source text.
  const styleBlockCss = collectStyleBlockCss(doc);
  const fontResult = extractFonts(doc, styleBlockCss);

  const out: BrandExtractionOutput = {
    provenance: {
      logo: logoProvenance,
      colors: colorResult.source,
      fonts: fontResult.source,
    },
  };

  if (name) out.name = name;
  if (tagline) out.tagline = tagline;
  if (description) out.description = description;
  if (logoUrl) out.logo_url = logoUrl;
  if (favicon) out.favicon_url = favicon.url;
  const ogImageResolved = safeAbsoluteUrl(og.ogImage, baseUrl);
  if (ogImageResolved) out.og_image_url = ogImageResolved;

  if (colorResult.colors.length > 0) out.primary_colors = colorResult.colors;

  if (fontResult.headings.length > 0 || fontResult.body.length > 0) {
    out.fonts = {};
    if (fontResult.headings.length > 0) out.fonts.headings = fontResult.headings;
    if (fontResult.body.length > 0) out.fonts.body = fontResult.body;
  }

  if (Object.keys(socialLinks).length > 0) {
    out.social_links = socialLinks;
  }

  log.debug('brand extracted', {
    baseUrl,
    hasLogo: Boolean(logoUrl),
    hasFavicon: Boolean(favicon),
    socials: Object.keys(socialLinks),
    colorCount: colorResult.colors.length,
    fontHeadings: fontResult.headings.length,
    fontBody: fontResult.body.length,
  });

  return out;
}

// Exported for tests so we can assert internal weighting without owning the
// public signature.
export const __internal = {
  parseColorToHex,
  rgbToHex,
  hslToHex,
  normalizeHex,
  categorizeSocial,
  extractColorsFromCss,
  extractFontsFromCss,
  splitFontFamilyList,
};

// Used by RGB scan as a fallback when the dominant lookup misses; not part
// of the public surface.
export function _internalScanColors(text: string): string[] {
  const hits = new Set<string>();
  for (const re of [HEX_RE, RGB_RE, HSL_RE]) {
    const matches = text.match(re) ?? [];
    for (const m of matches) {
      const hex = parseColorToHex(m);
      if (hex) hits.add(hex);
    }
  }
  return Array.from(hits);
}
