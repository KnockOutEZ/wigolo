import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../markdown.js';
import type { Extractor, ExtractionResult } from '../../types.js';

// Structured output shape for Reddit threads. Exported so callers (and tests)
// can consume the richer record alongside the standard ExtractionResult that
// the pipeline expects.
export interface RedditComment {
  author: string;
  body: string;
  score: number;
  replies: RedditComment[];
}

export interface RedditThread {
  title: string;
  author: string;
  subreddit: string;
  body_markdown: string;
  comments: RedditComment[];
  score: number;
  upvote_ratio: number;
  awards: string[];
  posted_at: string;
}

const THREAD_URL_RE = /\/r\/[^/]+\/comments\/[^/]+/;

// The Reddit response sometimes comes back as a generic
// "Whoa there, partner" / "blocked by network security" body when the
// upstream firewall flags the user-agent. The extractor used to parse that
// as a normal page, emit empty site_data, and silently pretend success.
// Detect the canonical block phrases so we can refuse to produce fake
// site_data and tell the caller via fetch_failed="blocked".
const REDDIT_BLOCK_PATTERNS: RegExp[] = [
  /blocked by network security/i,
  /whoa there,\s*partner/i,
  /our cdn was unable to reach our servers/i,
  /access to this page has been denied/i,
];

export function detectAntiBotBlock(html: string): string | null {
  if (!html) return null;
  // Limit the scan to the first ~10k chars — block bodies are tiny banner
  // pages; scanning megabytes of legitimate HTML would be wasteful and the
  // banner always appears near the top.
  const sample = html.slice(0, 10_000);
  for (const re of REDDIT_BLOCK_PATTERNS) {
    if (re.test(sample)) return 'blocked';
  }
  return null;
}

function isRedditHost(hostname: string): boolean {
  return (
    hostname === 'reddit.com' ||
    hostname === 'redd.it' ||
    hostname.endsWith('.reddit.com') ||
    hostname.endsWith('.redd.it')
  );
}

function parseScoreFromTitleAttr(el: Element | null): number {
  if (!el) return 0;
  const titleAttr = el.getAttribute('title');
  if (titleAttr && /^-?\d+$/.test(titleAttr)) {
    return parseInt(titleAttr, 10);
  }
  const text = el.textContent?.trim() ?? '';
  const m = text.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function textOrFallback(el: Element | null, fallback: string): string {
  const t = el?.textContent?.trim() ?? '';
  return t || fallback;
}

function normalizeDeletedMarker(md: string): string {
  // Turndown escapes literal "[removed]"/"[deleted]" markers as "\[removed\]".
  // Agents and downstream regexes key off the unescaped form, so unescape
  // only those specific sentinels — leave all other markdown intact.
  return md
    .replace(/\\\[removed\\\]/gi, '[removed]')
    .replace(/\\\[deleted\\\]/gi, '[deleted]');
}

function extractPostBodyMarkdown(thingEl: Element): string {
  const bodyEl = thingEl.querySelector('.expando .usertext-body .md, .expando .md');
  if (!bodyEl) {
    // Deleted / removed posts often have no body element at all.
    return '[deleted]';
  }
  const md = normalizeDeletedMarker(htmlToMarkdown((bodyEl as Element).innerHTML).trim());
  if (!md) return '[deleted]';
  return md;
}

function parseComment(commentEl: Element): RedditComment {
  const isDeleted = commentEl.classList.contains('deleted');
  const dataAuthor = commentEl.getAttribute('data-author') ?? '';
  const author = dataAuthor || textOrFallback(commentEl.querySelector('.tagline .author'), '[deleted]');

  const scoreAttr = commentEl.getAttribute('data-score-likes');
  let score = scoreAttr && /^-?\d+$/.test(scoreAttr) ? parseInt(scoreAttr, 10) : NaN;
  if (Number.isNaN(score)) {
    score = parseScoreFromTitleAttr(commentEl.querySelector('.tagline .score'));
  }

  const bodyEl = commentEl.querySelector(':scope > .entry .usertext-body .md');
  let body: string;
  if (isDeleted) {
    body = '[deleted]';
  } else if (!bodyEl) {
    body = '[deleted]';
  } else {
    body = normalizeDeletedMarker(htmlToMarkdown((bodyEl as Element).innerHTML).trim()) || '[deleted]';
  }

  return {
    author: isDeleted ? '[deleted]' : author || '[deleted]',
    body,
    score: Number.isFinite(score) ? score : 0,
    replies: [],
  };
}

function parseTopLevelComments(document: Document): RedditComment[] {
  // Only direct children of .commentarea .sitetable.nestedlisting are
  // top-level comments. Reddit nests deeper comments inside a separate
  // .child container — we explicitly skip those for the top-N requirement.
  const containers = document.querySelectorAll('.commentarea > .sitetable.nestedlisting');
  const out: RedditComment[] = [];
  for (const container of Array.from(containers)) {
    for (const node of Array.from(container.children)) {
      if (!(node as Element).classList?.contains('comment')) continue;
      out.push(parseComment(node as Element));
    }
  }
  // Defensive: if nothing matched the strict selector (newer dump shapes can
  // omit the wrapper), fall back to all .comment.thing nodes inside the
  // comment area.
  if (out.length === 0) {
    const fallback = document.querySelectorAll('.commentarea .thing.comment');
    for (const node of Array.from(fallback)) {
      out.push(parseComment(node as Element));
    }
  }
  return out;
}

function parseAwards(thingEl: Element): string[] {
  const bar = thingEl.querySelector('.awardings-bar');
  if (!bar) return [];
  const raw = bar.textContent?.trim() ?? '';
  if (!raw) return [];
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseUpvoteRatio(thingEl: Element): number {
  const attr =
    thingEl.getAttribute('data-upvote-ratio') ??
    thingEl.getAttribute('data-percent') ??
    '';
  if (!attr) return 1;
  const n = parseFloat(attr);
  if (!Number.isFinite(n)) return 1;
  // Reddit historically uses 0..1 in data-upvote-ratio. Normalize percentages
  // (1..100) defensively so callers can rely on the 0..1 contract.
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function parsePostedAt(thingEl: Element): string {
  const timeEl = thingEl.querySelector('time[datetime]');
  return timeEl?.getAttribute('datetime')?.trim() ?? '';
}

function parseThreadCore(html: string): RedditThread | null {
  const { document } = parseHTML(html);

  const thingEl = document.querySelector(
    '#siteTable .thing.link, #siteTable .thing',
  ) as Element | null;
  if (!thingEl) return null;

  const subreddit =
    thingEl.getAttribute('data-subreddit') ??
    textOrFallback(thingEl.querySelector('.subreddit'), '').replace(/^\/r\//, '');

  if (!subreddit) return null;

  // Title — prefer the visible link inside the post, then og:title, then <title>.
  const linkTitleEl = thingEl.querySelector('a.title, p.title a');
  const ogTitleEl = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
  const docTitleEl = document.querySelector('title');
  const titleCandidate =
    linkTitleEl?.textContent?.trim() ||
    ogTitleEl?.getAttribute('content')?.trim() ||
    docTitleEl?.textContent?.split(':')[0]?.trim() ||
    '';
  const title = titleCandidate;

  const dataAuthor = thingEl.getAttribute('data-author') ?? '';
  const author = dataAuthor || textOrFallback(thingEl.querySelector('.tagline .author'), '[deleted]');

  const body_markdown = extractPostBodyMarkdown(thingEl);
  const score = parseScoreFromTitleAttr(thingEl.querySelector('.midcol .score, .score.likes'));
  const upvote_ratio = parseUpvoteRatio(thingEl);
  const awards = parseAwards(thingEl);
  const posted_at = parsePostedAt(thingEl);
  const comments = parseTopLevelComments(document);

  return {
    title,
    author: author || '[deleted]',
    subreddit,
    body_markdown,
    comments,
    score,
    upvote_ratio,
    awards,
    posted_at,
  };
}

export function extractRedditThread(html: string, _url: string): RedditThread | null {
  if (!html) return null;
  const thread = parseThreadCore(html);
  if (!thread) return null;
  // Sort comments by score descending — that is the product-visible ordering
  // agents (and humans) rely on for "what does the community think".
  thread.comments = [...thread.comments].sort((a, b) => b.score - a.score);
  return thread;
}

function buildMarkdown(thread: RedditThread): string {
  const lines: string[] = [];
  lines.push(`# ${thread.title}`);
  lines.push('');
  const headerBits: string[] = [`Subreddit: r/${thread.subreddit}`, `Author: u/${thread.author}`];
  if (Number.isFinite(thread.score)) headerBits.push(`Score: ${thread.score}`);
  if (thread.upvote_ratio !== undefined) headerBits.push(`Upvote ratio: ${thread.upvote_ratio}`);
  if (thread.posted_at) headerBits.push(`Posted: ${thread.posted_at}`);
  if (thread.awards.length > 0) headerBits.push(`Awards: ${thread.awards.join(', ')}`);
  lines.push(headerBits.join(' | '));
  lines.push('');
  lines.push(thread.body_markdown || '[deleted]');
  lines.push('');
  if (thread.comments.length > 0) {
    lines.push('## Comments');
    lines.push('');
    for (const c of thread.comments) {
      lines.push(`### u/${c.author} — ${c.score} points`);
      lines.push('');
      lines.push(c.body);
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

export const redditExtractor: Extractor = {
  name: 'reddit',

  canHandle(url: string): boolean {
    try {
      const u = new URL(url);
      if (!isRedditHost(u.hostname)) return false;
      // redd.it short links route to threads; treat the whole host as a match.
      if (u.hostname === 'redd.it' || u.hostname.endsWith('.redd.it')) return true;
      return THREAD_URL_RE.test(u.pathname);
    } catch {
      return false;
    }
  },

  extract(html: string, url: string): ExtractionResult | null {
    if (!html) return null;
    // Refuse to produce site_data when the body is a known
    // anti-bot / firewall challenge page. The caller learns about this via
    // the fetch envelope's fetch_failed="blocked" surface (set in routed.ts).
    if (detectAntiBotBlock(html)) return null;
    const thread = extractRedditThread(html, url);
    if (!thread) return null;
    if (!thread.title) return null;

    const markdown = buildMarkdown(thread);

    return {
      title: thread.title,
      markdown,
      metadata: {
        author: thread.author,
        date: thread.posted_at || undefined,
        keywords: [`r/${thread.subreddit}`],
      },
      links: [],
      images: [],
      extractor: 'site-specific',
      // Structured thread record threaded outward so routedExtract can surface
      // it on the FetchOutput without re-parsing the HTML a second time.
      site_data: thread as unknown as Record<string, unknown>,
    };
  },
};
