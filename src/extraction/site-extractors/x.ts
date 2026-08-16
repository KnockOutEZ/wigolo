import { parseHTML } from 'linkedom';
import type { Extractor, ExtractionResult } from '../../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// X (twitter.com / x.com) post extractor — content-free bodies only
//
// Scope is deliberately narrow on two axes at once:
//   1. post and article permalinks only (`/<handle>/status|article/<id>`);
//   2. only when the body carries no readable prose of its own.
//
// WHY (2) IS THERE. X normally server-renders around a thousand characters of
// app chrome, which is enough for the generic extractor chain to produce a
// result. That path is measured and working, so this extractor deliberately
// does NOT touch it — it would be substituting an unmeasured output for a
// measured one. It fires only on the case the generic chain genuinely cannot
// serve: a body with nothing readable in it, where the chain bottoms out at
// the "JavaScript is not available" notice.
//
// WHY IT EXISTS AT ALL. On that content-free body the bundled content
// extractor's async path used to reach for an unaffiliated third-party API and
// an oEmbed endpoint — undeclared requests on the bare global fetch, outside
// wigolo's proxy and logging. Those are now off (see extraction/defuddle.ts).
// X puts the post's author and full text in its own card metadata (`og:` /
// `twitter:`), in the SAME response wigolo already fetched, so the content is
// recoverable with zero additional network — on every fetch tier, including the
// http-only and cache modes where no browser is available to render the page.
//
// Returns null whenever either gate fails, so anything outside this narrow case
// reaches the normal extractor chain exactly as it does today.
// ─────────────────────────────────────────────────────────────────────────────

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

// Mirrors the URL shape the bundled extractor's async path keyed on, so this
// extractor covers exactly the pages that used to reach it.
const POST_PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/(status|article)\/(\d+)/;

// Prose floor below which the generic chain has nothing to work with. Matches
// the fetch layer's own empty-body threshold so the two agree on what "the page
// rendered nothing" means. `<noscript>` is excluded: the JavaScript-required
// notice is precisely the string that signals an unrendered page, so counting
// it would defeat the check.
const READABLE_PROSE_THRESHOLD = 200;

function readableProseLength(html: string): number {
  const withoutInert = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  return withoutInert.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

interface PostRef {
  handle: string;
  kind: string;
  postId: string;
}

function parsePostUrl(url: string): PostRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = POST_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  return { handle: match[1], kind: match[2], postId: match[3] };
}

function getMeta(document: Document, keys: readonly string[]): string {
  for (const key of keys) {
    const attr = key.startsWith('og:') || key.startsWith('article:') ? 'property' : 'name';
    const el = document.querySelector(`meta[${attr}="${key}"]`);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
    // Some pages swap property/name for the same key — check the other form
    // before giving up rather than silently reporting the field as absent.
    const other = attr === 'property' ? 'name' : 'property';
    const alt = document.querySelector(`meta[${other}="${key}"]`);
    const altContent = alt?.getAttribute('content')?.trim();
    if (altContent) return altContent;
  }
  return '';
}

// `og:title` reads "Jane Doe on X", or "Jane Doe (@janedoe) on X" — recover the
// display name alone so the rendered heading does not repeat the handle.
function displayNameFromTitle(title: string, handle: string): string {
  const stripped = title
    .replace(/\s+on\s+(X|Twitter)\s*$/i, '')
    .replace(new RegExp(`\\s*\\(@${handle}\\)\\s*$`, 'i'), '')
    .trim();
  if (stripped && stripped.toLowerCase() !== `@${handle.toLowerCase()}`) return stripped;
  return '';
}

function buildMarkdown(ref: PostRef, name: string, text: string, postedAt: string): string {
  const heading = name ? `${name} (@${ref.handle})` : `@${ref.handle}`;
  const lines = [`# ${heading}`, ''];
  if (postedAt) {
    lines.push(`**Posted:** ${postedAt}`);
    lines.push('');
  }
  lines.push(text);
  return lines.join('\n').trim();
}

export const xExtractor: Extractor = {
  name: 'x',

  canHandle(url: string): boolean {
    return parsePostUrl(url) !== null;
  },

  extract(html: string, url: string): ExtractionResult | null {
    if (!html) return null;
    const ref = parsePostUrl(url);
    if (!ref) return null;

    // The page rendered something the generic chain can extract — leave it
    // alone. See the header: not substituting an unmeasured output for a
    // measured one is the point.
    if (readableProseLength(html) >= READABLE_PROSE_THRESHOLD) return null;

    const { document } = parseHTML(html);

    const text = getMeta(document, ['og:description', 'twitter:description', 'description']);
    // No card text means this response tells us nothing about the post that the
    // generic chain would not also find. Fall through instead of returning a
    // header with an empty body.
    if (!text) return null;

    const rawTitle = getMeta(document, ['og:title', 'twitter:title']);
    const name = displayNameFromTitle(rawTitle, ref.handle);
    const postedAt = getMeta(document, ['article:published_time']);
    const canonical = getMeta(document, ['og:url']) || url;

    const siteData: Record<string, unknown> = {
      post_id: ref.postId,
      post_kind: ref.kind,
      author_handle: ref.handle,
      author_name: name,
      text,
      url: canonical,
    };
    if (postedAt) siteData.posted_at = postedAt;

    return {
      title: rawTitle || `Post by @${ref.handle}`,
      markdown: buildMarkdown(ref, name, text, postedAt),
      metadata: {
        description: text,
        author: name ? `${name} (@${ref.handle})` : `@${ref.handle}`,
        date: postedAt || undefined,
        canonical_url: canonical,
      },
      links: [],
      images: [],
      extractor: 'site-specific',
      site_data: siteData,
    };
  },
};
