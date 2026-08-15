import { extractSection, extractLinksAndImages } from './markdown.js';
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

/**
 * Does the body open as an HTML *document*? Deliberately anchored to the start
 * of the body rather than searching it: README files routinely embed `<div>`,
 * `<img>` and `<details>`, and a substring test would reject a large share of
 * real markdown.
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
  return /^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head);
}

/**
 * Decide whether a body should bypass extraction, and how.
 *
 * Returns null — meaning "extract as before" — for everything not positively
 * identified. That direction is the safe one: an unrecognised or mislabelled
 * body keeps today's behaviour, including the anti-bot detection that lives in
 * the routed extractor.
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

function absolutize(refs: string[], pageUrl: string): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    try {
      out.push(new URL(ref, pageUrl).href);
    } catch {
      // A relative reference we cannot resolve is dropped rather than
      // reported as a page link that does not exist.
    }
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
 *  - `links`/`images` for a text body are the anchors genuinely present in the
 *    source, resolved against the page URL so crawl and cache consumers keep
 *    getting absolute URLs. For JSON they are empty: a JSON document has no
 *    anchors, and a string value that happens to contain `[x](y)` is data, not
 *    a link on the page.
 *  - `title` is empty rather than invented.
 *
 * `content_completeness` is untouched: it is produced by the browser tier for
 * rendered pages and is absent on these HTTP responses either way.
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
    const found = extractLinksAndImages(markdown);
    links = absolutize(found.links, url);
    images = absolutize(found.images, url);
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
