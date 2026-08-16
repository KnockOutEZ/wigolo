import { parseHTML } from 'linkedom';
import type { Extractor, ExtractionResult } from '../../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// X (twitter.com / x.com) post extractor
//
// Scope is deliberately narrow: individual post and article permalinks
// (`/<handle>/status/<id>`, `/<handle>/article/<id>`). Profiles, timelines and
// everything else keep the generic extraction path unchanged.
//
// WHY THIS EXISTS. X serves post pages as a client-rendered app. When the body
// carries no readable prose, the bundled content extractor's async path used to
// recover the post by calling an unaffiliated third-party API and an oEmbed
// endpoint — undeclared requests, on the bare global fetch, outside wigolo's
// proxy and logging. Those requests are now off (see extraction/defuddle.ts).
//
// The recovery does not need them. X puts the post's author and full text in
// its own card metadata (`og:` / `twitter:`), in the SAME response wigolo has
// already fetched. Reading it here is zero additional network, works on every
// fetch tier including http-only and cache modes where no browser is available,
// and — because site extractors short-circuit ahead of the fallback chain —
// structurally keeps X post pages away from the third-party path for good.
//
// Returns null when the response carries no card text, so a page that genuinely
// rendered its content still falls through to the normal extractor chain.
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
