import { extractSection, extractLinksAndImages, isDecorativeImage } from './markdown.js';
import type { ExtractionResult } from '../types.js';

/**
 * Content-type passthrough.
 *
 * The extraction pipeline is an HTML-to-markdown converter. When the response
 * body is already markdown, or is JSON, running it through that converter is a
 * category error: markdown-significant characters get backslash-escaped and
 * block whitespace collapses, so a README comes back as one line of `\# Title`
 * and a JSON document comes back unparseable.
 *
 * Routing is on the response content-type — the URL suffix is a hint, the
 * header is the fact (raw.githubusercontent.com serves `.md` as `text/plain`,
 * and plenty of markdown is served from extensionless URLs).
 */

export type PassthroughKind = 'json' | 'text';

/** Bare lowercase mime type: parameters (`; charset=…`) and casing removed. */
export function parseMimeType(contentType?: string): string {
  if (!contentType) return '';
  return contentType.split(';')[0]!.trim().toLowerCase();
}

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

// Tags that, when they are the very first thing in a body, mean the body is an
// HTML document rather than text. `<div>` is deliberately absent: a centred
// badge block is how a large share of real READMEs open.
const HTML_DOCUMENT_OPENERS =
  /^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|meta[\s>]|title[\s>]|link[\s>]|style[\s>]|script[\s>])/i;

/**
 * Does the body look like an HTML *document*?
 *
 * Two shapes count: it opens with a document-level tag, or it closes with
 * `</html>` / `</body>`. Both are anchored to an edge on purpose. A "contains
 * `</html>` anywhere" test would reject exactly the files this change protects
 * — web-framework READMEs quote entire HTML documents inside code fences.
 */
function looksLikeHtmlDocument(body: string): boolean {
  // Skip leading whitespace (trimStart also removes a BOM — U+FEFF is
  // whitespace per ECMA-262), an XML prolog, and any leading comments.
  let head = body.trimStart();
  for (;;) {
    const before = head;
    head = head.replace(/^<\?xml[^>]*\?>/i, '').trimStart();
    head = head.replace(/^<!--[\s\S]*?-->/, '').trimStart();
    if (head === before) break;
  }
  if (HTML_DOCUMENT_OPENERS.test(head)) return true;

  return /<\/(html|body)>$/i.test(body.trimEnd());
}

/**
 * Decide whether a body should bypass extraction, and how.
 *
 * Returns null — meaning "extract as before" — for everything not positively
 * identified. That direction is the safe one: an unrecognised body, or an
 * HTML-shaped body under any label, keeps today's behaviour.
 *
 * On anti-bot handling, precisely: challenge pages are served as `text/html`
 * and are classified before extraction, and `src/tools/fetch.ts` short-circuits
 * `>= 400` machine-typed bodies, so the primary path is unaffected. The one
 * detector that does sit inside extraction — `detectSiteBlock` in
 * `v1/routed.ts`, for Reddit and Amazon — becomes content-type-conditional
 * here: a block banner delivered as `text/plain` with a 2xx status would pass
 * through instead of setting `site_data_blocked`. The HTML-document guard below
 * covers the realistic shape of that body.
 *
 * The declared type is never trusted on its own:
 *  - JSON must actually parse. That is proof rather than a hint, and it costs
 *    far less than the DOM parse it replaces.
 *  - Text must not open as an HTML document, so a server that mislabels an
 *    HTML page as `text/plain` still gets extracted.
 */
export function classifyPassthrough(
  contentType: string | undefined,
  body: string,
): PassthroughKind | null {
  const mime = parseMimeType(contentType);
  if (!mime) return null;

  if (mime === 'application/json' || mime.endsWith('+json')) {
    try {
      JSON.parse(body);
      return 'json';
    } catch {
      return null;
    }
  }

  if (TEXT_TYPES.has(mime)) {
    return looksLikeHtmlDocument(body) ? null : 'text';
  }

  return null;
}

export interface PassthroughOptions {
  maxChars?: number;
  section?: string;
  sectionIndex?: number;
}

function absolutize(refs: Iterable<string>, pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    let href: string;
    try {
      // An already-absolute reference is kept exactly as written. Passing it
      // through `new URL()` would canonicalize it (`https://x.com` gains a
      // trailing slash), which the extractor this path replaces never did.
      new URL(ref);
      href = ref;
    } catch {
      try {
        href = new URL(ref, pageUrl).href;
      } catch {
        // A relative reference we cannot resolve is dropped rather than
        // reported as a page link that does not exist.
        continue;
      }
    }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

const HTML_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const HTML_IMG_RE =
  /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/gi;
const HTML_IMG_ALT_RE = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function attrValue(m: RegExpExecArray, first: number): string {
  return m[first] ?? m[first + 1] ?? m[first + 2] ?? '';
}

/**
 * Anchors and images written as raw HTML inside a text body.
 *
 * `extractLinksAndImages` understands markdown syntax only, so on its own it
 * drops every URL in an HTML badge block — which is how most READMEs open, and
 * which the HTML-to-markdown converter used to pick up. `links` is the crawler's
 * only source of traversal edges, so losing them loses pages.
 */
function htmlRefs(body: string): { links: string[]; images: string[] } {
  const links: string[] = [];
  const images: string[] = [];

  for (const m of body.matchAll(HTML_HREF_RE)) {
    const href = attrValue(m as RegExpExecArray, 2).trim();
    if (href) links.push(href);
  }

  for (const m of body.matchAll(HTML_IMG_RE)) {
    const tag = m[0];
    const src = attrValue(m as RegExpExecArray, 2).trim();
    if (!src) continue;
    const altMatch = HTML_IMG_ALT_RE.exec(tag);
    const alt = altMatch ? (altMatch[2] ?? altMatch[3] ?? altMatch[4] ?? '') : '';
    if (!isDecorativeImage(src, alt)) images.push(src);
  }

  return { links, images };
}

/**
 * Markdown image tokens that survive the decorative filter. The filter itself
 * rewrites markdown; here the body must stay verbatim, so the same predicate is
 * applied to the derived list instead.
 */
function markdownContentImages(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const alt = m[1] ?? '';
    const src = m[2] ?? '';
    if (src && !isDecorativeImage(src, alt)) out.push(src);
  }
  return out;
}

/**
 * Build the extraction result for a passthrough body.
 *
 * `markdown` is the body verbatim — that is the entire point, so no
 * URL rewriting, boilerplate stripping or sanitization runs over it.
 *
 * The derived fields are reported honestly rather than fabricated:
 *  - `metadata` is `{}`. There are no meta tags in a text or JSON body.
 *  - `links`/`images` for a text body are the references genuinely present in
 *    the source — written either as markdown syntax or as raw `<a>`/`<img>`
 *    HTML, since a text body may contain both — resolved against the page URL
 *    so crawl and cache consumers keep getting absolute URLs. Note the body
 *    itself is never rewritten, so a relative reference stays relative inside
 *    `markdown` while `links` carries the resolved form.
 *  - `images` drops decorative badges/shields/logos, matching the extractor
 *    this path replaces.
 *  - For JSON both are empty: a JSON document has no anchors, and a string
 *    value that happens to contain `[x](y)` is data, not a link on the page.
 *  - `title` is empty rather than invented.
 *
 * `content_completeness` is untouched — but NOT because the field belongs to
 * the browser tier; the extraction seam also produces it, on every tier. It is
 * absent here because a verbatim body has no extraction step to lose content
 * in, so no producer is entitled to a verdict.
 */
export function buildPassthroughResult(
  body: string,
  kind: PassthroughKind,
  url: string,
  options: PassthroughOptions = {},
): ExtractionResult {
  let markdown = body;

  if (options.section) {
    const { content } = extractSection(markdown, options.section, options.sectionIndex ?? 0);
    markdown = content;
  }

  let links: string[] = [];
  let images: string[] = [];
  if (kind === 'text') {
    const fromMarkdown = extractLinksAndImages(markdown);
    const fromHtml = htmlRefs(markdown);
    links = absolutize([...fromMarkdown.links, ...fromHtml.links], url);
    images = absolutize([...markdownContentImages(markdown), ...fromHtml.images], url);
  }

  if (options.maxChars && markdown.length > options.maxChars) {
    markdown = markdown.slice(0, options.maxChars);
  }

  return {
    title: '',
    markdown,
    metadata: {},
    links,
    images,
    extractor: 'passthrough',
  };
}
