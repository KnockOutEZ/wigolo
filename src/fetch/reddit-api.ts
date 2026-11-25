/**
 * Opt-in Reddit OAuth-API fetch path (credential-gated escape hatch).
 *
 * reddit.com blocks wigolo at the IP-reputation edge — even the full stealth
 * browser lands on a "blocked by network security" interstitial and the `.json`
 * path 403s. Fingerprint / behavior levers do not clear that. The sanctioned,
 * reliable Reddit path is the official OAuth API.
 *
 * When Reddit app credentials are configured (client_id + client_secret) AND a
 * fetch targets a Reddit URL, the router routes here: we mint an app-only
 * (client-credentials) bearer token, translate the input URL into the matching
 * `oauth.reddit.com` endpoint, fetch the JSON, and map it into wigolo's
 * RawFetchResult envelope with `method: 'reddit-api'`.
 *
 * When credentials are ABSENT this module is never reached — the router falls
 * through to the normal fetch ladder (which honestly hits the block). This is an
 * escape hatch, never a hard requirement.
 *
 * SSRF: the egress hosts are FIXED (`www.reddit.com` for the token,
 * `oauth.reddit.com` for data). Endpoint URLs are built from a fixed base plus a
 * path derived (and sanitized) from the input — never from a user-controlled
 * host. Every constructed URL is still run through `guardFetchUrl`.
 */

import type { RawFetchResult } from '../types.js';
import type { RedditThread, RedditComment } from '../extraction/site-extractors/reddit.js';
import { guardFetchUrl } from '../watch/ssrf.js';
import { createLogger } from '../logger.js';
import { anySignal } from '../util/abort.js';

/**
 * Hard ceiling on each Reddit HTTP call. The default `fetch` has no request
 * timeout, so a stalled token mint or data request would hold the router's
 * fetch path open until the process exits instead of falling through to the
 * normal ladder. Combined with any caller signal, so cancellation still wins.
 */
const REDDIT_REQUEST_TIMEOUT_MS = 15_000;

/** Fixed OAuth token endpoint — app-only (client-credentials) grant. */
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
/** Fixed data host. All listing / comments / user endpoints hang off this. */
const OAUTH_BASE = 'https://oauth.reddit.com';

/** Reddit host families the API path recognizes. */
const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'redd.it',
]);

/**
 * True when `url`'s hostname is a Reddit host (or a subdomain of one). Used by
 * the router to decide whether the credential-gated API path applies.
 */
export function isRedditUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (REDDIT_HOSTS.has(host)) return true;
  return host.endsWith('.reddit.com') || host.endsWith('.redd.it');
}

// ---------------------------------------------------------------------------
// URL → endpoint mapping
// ---------------------------------------------------------------------------

const SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);

/**
 * A reddit name segment (sub / user / id), or null when the input is not already
 * one. Reddit names are `[A-Za-z0-9_-]+`, so anything else cannot be served.
 *
 * This REJECTS rather than sanitizes. Stripping the offending characters keeps
 * the fixed-host URL safe but silently changes WHICH resource is fetched —
 * `/r/foo.bar` became `/r/foobar`, and `/r/AskReddit%2F..%2Fpolitics` became the
 * real-but-wrong `/r/AskReddit2F2Fpolitics` — handing back another community's
 * content with no signal. Returning null makes the router fall through to the
 * normal ladder against the URL as the caller wrote it.
 */
function validSegment(seg: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(seg) ? seg : null;
}

/**
 * Translate a Reddit URL into the matching `oauth.reddit.com` endpoint path.
 * Returns null for shapes we do not handle — the caller then falls through to
 * the normal fetch ladder rather than guessing.
 *
 * Handled shapes:
 *   - /r/<sub>/comments/<id>[/...]  → /r/<sub>/comments/<id> (thread + comments)
 *   - /r/<sub>[/<sort>]             → /r/<sub>/<sort> listing (default: hot)
 *   - /user/<name> or /u/<name>     → /user/<name>/about
 */
export function mapRedditUrlToEndpoint(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  // redd.it/<id> short links resolve to a thread; the API cannot resolve the
  // shortcode directly, so we leave those to the normal ladder.
  if (host === 'redd.it' || host.endsWith('.redd.it')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // /user/<name> or /u/<name>
  if ((parts[0] === 'user' || parts[0] === 'u') && parts[1]) {
    const name = validSegment(parts[1]);
    if (!name) return null;
    return `/user/${name}/about`;
  }

  // /r/<sub>/...
  if (parts[0] === 'r' && parts[1]) {
    const sub = validSegment(parts[1]);
    if (!sub) return null;

    // /r/<sub>/comments/<id>[/slug]
    if (parts[2] === 'comments' && parts[3]) {
      const id = validSegment(parts[3]);
      if (!id) return null;
      return `/r/${sub}/comments/${id}`;
    }

    // /r/<sub>[/<sort>]
    const sort = parts[2] && SORTS.has(parts[2].toLowerCase()) ? parts[2].toLowerCase() : 'hot';
    return `/r/${sub}/${sort}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------------

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

/** Injectable fetch surface so tests never touch the network. */
export type FetchFn = typeof fetch;

interface CachedToken {
  token: string;
  /** Absolute epoch-ms at which the token is considered expired. */
  expiresAt: number;
}

/**
 * Mints and caches an app-only bearer token via the client-credentials grant.
 * The token is refreshed once it is within `SKEW_MS` of expiry. A single
 * manager instance is reused across fetches so the token is minted at most once
 * per validity window.
 */
export class RedditTokenManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  /** Refresh a little before the real expiry so an in-flight request never
   * races an edge-of-life token. */
  private static readonly SKEW_MS = 30_000;

  constructor(
    private readonly creds: RedditCredentials,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** A valid bearer token, minting or refreshing as needed. */
  async getToken(): Promise<string> {
    const t = this.now();
    if (this.cached && this.cached.expiresAt - RedditTokenManager.SKEW_MS > t) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async mint(): Promise<string> {
    // NEVER log the secret. Basic auth = base64(client_id:client_secret).
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    const guard = guardFetchUrl(TOKEN_URL, 'reddit token endpoint');
    if (!guard.ok) {
      throw new Error(`reddit token endpoint failed SSRF guard: ${guard.reason}`);
    }
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.creds.userAgent,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(REDDIT_REQUEST_TIMEOUT_MS),
      // The token endpoint is a fixed host and must never legitimately
      // redirect. `redirect: 'manual'` disables the auto-follower so a hostile
      // 3xx (e.g. to an internal address) is never followed with the Basic
      // credentials attached; we reject any 3xx below.
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`reddit token endpoint returned an unexpected redirect (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`reddit token request failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw new Error('reddit token response missing access_token');
    }
    const expiresInSec = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
    this.cached = {
      token: json.access_token,
      expiresAt: this.now() + expiresInSec * 1000,
    };
    // Logger built per-call so it honours the current config log level. NEVER
    // include the secret or the minted token in the log data.
    createLogger('fetch').debug('minted reddit app-only token', { expiresInSec });
    return this.cached.token;
  }
}

// ---------------------------------------------------------------------------
// JSON → RawFetchResult mapping
// ---------------------------------------------------------------------------

interface RedditApiChild {
  kind?: string;
  data?: Record<string, unknown>;
}

interface RedditListing {
  kind?: string;
  data?: { children?: RedditApiChild[] };
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Map an API comment node (t1) into wigolo's RedditComment shape, recursively. */
function mapComment(child: RedditApiChild): RedditComment | null {
  if (child.kind !== 't1' || !child.data) return null;
  const d = child.data;
  const repliesRaw = d.replies;
  const replies: RedditComment[] = [];
  if (repliesRaw && typeof repliesRaw === 'object') {
    const listing = repliesRaw as RedditListing;
    for (const c of listing.data?.children ?? []) {
      const mapped = mapComment(c);
      if (mapped) replies.push(mapped);
    }
  }
  return {
    author: str(d.author, '[deleted]') || '[deleted]',
    body: str(d.body, '[deleted]') || '[deleted]',
    score: num(d.score),
    replies,
  };
}

function buildThreadMarkdown(thread: RedditThread): string {
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

/**
 * Structured result of a Reddit API fetch: an HTML-free envelope carrying the
 * title, rendered markdown, per-site structured data, and the upstream status.
 * The router folds these fields onto the RawFetchResult it returns.
 */
export interface RedditApiFetchResult {
  title: string;
  markdown: string;
  site_data?: Record<string, unknown>;
  http_status: number;
}

/** Map a comments-endpoint payload (an array: [postListing, commentsListing]). */
function mapThread(payload: unknown): RedditApiFetchResult | null {
  if (!Array.isArray(payload) || payload.length < 1) return null;
  const postListing = payload[0] as RedditListing;
  const post = postListing?.data?.children?.[0]?.data;
  if (!post) return null;

  const comments: RedditComment[] = [];
  if (payload.length >= 2) {
    const commentListing = payload[1] as RedditListing;
    for (const c of commentListing?.data?.children ?? []) {
      const mapped = mapComment(c);
      if (mapped) comments.push(mapped);
    }
  }

  const thread: RedditThread = {
    title: str(post.title),
    author: str(post.author, '[deleted]') || '[deleted]',
    subreddit: str(post.subreddit),
    body_markdown: str(post.selftext) || '[deleted]',
    comments: [...comments].sort((a, b) => b.score - a.score),
    score: num(post.score),
    upvote_ratio: typeof post.upvote_ratio === 'number' ? post.upvote_ratio : 1,
    awards: [],
    posted_at:
      typeof post.created_utc === 'number' ? new Date(post.created_utc * 1000).toISOString() : '',
  };

  return {
    title: thread.title,
    markdown: buildThreadMarkdown(thread),
    site_data: thread as unknown as Record<string, unknown>,
    http_status: 200,
  };
}

/** Map a subreddit listing payload into a link-index markdown page. */
function mapListing(payload: unknown): RedditApiFetchResult | null {
  const listing = payload as RedditListing;
  const children = listing?.data?.children;
  if (!Array.isArray(children)) return null;

  const posts = children
    .filter((c) => c.kind === 't3' && c.data)
    .map((c) => c.data as Record<string, unknown>);

  const subreddit = posts.length > 0 ? str(posts[0].subreddit) : '';
  const title = subreddit ? `r/${subreddit}` : 'Reddit listing';
  const lines: string[] = [`# ${title}`, ''];
  for (const p of posts) {
    const permalink = str(p.permalink);
    const link = permalink ? `https://www.reddit.com${permalink}` : str(p.url);
    lines.push(`- [${str(p.title, '(untitled)')}](${link}) — ${num(p.score)} points, ${num(p.num_comments)} comments`);
  }

  return {
    title,
    markdown: lines.join('\n').trim(),
    site_data: {
      subreddit,
      posts: posts.map((p) => ({
        title: str(p.title),
        author: str(p.author),
        score: num(p.score),
        num_comments: num(p.num_comments),
        permalink: str(p.permalink),
        url: str(p.url),
      })),
    },
    http_status: 200,
  };
}

/** Map a /user/<name>/about payload. */
function mapUser(payload: unknown): RedditApiFetchResult | null {
  const obj = payload as { kind?: string; data?: Record<string, unknown> };
  const d = obj?.data;
  if (!d) return null;
  const name = str(d.name);
  const title = name ? `u/${name}` : 'Reddit user';
  const lines: string[] = [`# ${title}`, ''];
  lines.push(`Link karma: ${num(d.link_karma)} | Comment karma: ${num(d.comment_karma)}`);
  if (typeof d.created_utc === 'number') {
    lines.push(`Account created: ${new Date(d.created_utc * 1000).toISOString()}`);
  }
  return {
    title,
    markdown: lines.join('\n').trim(),
    site_data: {
      name,
      link_karma: num(d.link_karma),
      comment_karma: num(d.comment_karma),
      created_utc: num(d.created_utc),
    },
    http_status: 200,
  };
}

function mapPayload(payload: unknown, endpointPath: string): RedditApiFetchResult | null {
  if (endpointPath.includes('/comments/')) return mapThread(payload);
  if (endpointPath.startsWith('/user/')) return mapUser(payload);
  return mapListing(payload);
}

/** Thrown when Reddit rate-limits us; carries the Retry-After hint (seconds). */
export class RedditRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super('reddit API rate limited (HTTP 429)');
    this.name = 'RedditRateLimitError';
  }
}

/**
 * Fetch a Reddit URL via the OAuth API and return a RawFetchResult-shaped
 * envelope. Returns null when the URL shape is unsupported (caller falls
 * through). Throws RedditRateLimitError on 429 and Error on other failures.
 */
export async function fetchViaRedditApi(
  url: string,
  tokenManager: RedditTokenManager,
  creds: RedditCredentials,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<RawFetchResult | null> {
  const endpointPath = mapRedditUrlToEndpoint(url);
  if (endpointPath === null) return null;

  // Build the endpoint URL from the FIXED base + sanitized path. `raw=json` is
  // implied by the OAuth host. The host can never be caller-controlled.
  const endpointUrl = `${OAUTH_BASE}${endpointPath}?raw_json=1&limit=100`;
  const guard = guardFetchUrl(endpointUrl, 'reddit oauth endpoint');
  if (!guard.ok) {
    throw new Error(`reddit oauth endpoint failed SSRF guard: ${guard.reason}`);
  }

  const token = await tokenManager.getToken();
  // Bounded, and still cancellable by the caller — whichever fires first. The
  // combiner attaches a listener to the caller's (long-lived, shared) signal,
  // so its cleanup runs as soon as this request settles; skipping it would
  // accumulate one listener per fetch on that signal.
  const combined = signal
    ? anySignal([signal, AbortSignal.timeout(REDDIT_REQUEST_TIMEOUT_MS)])
    : null;
  let res: Response;
  try {
    res = await fetchFn(endpointUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': creds.userAgent,
      },
      signal: combined ? combined.signal : AbortSignal.timeout(REDDIT_REQUEST_TIMEOUT_MS),
      // The OAuth data host is fixed and must never legitimately redirect.
      // `redirect: 'manual'` disables the auto-follower (default: follow, up to
      // 20 hops) so a hostile 3xx to an internal address is never followed with
      // the bearer token attached. Any 3xx is rejected below, which makes the
      // router fall through to the normal fetch ladder.
      redirect: 'manual',
    });
  } finally {
    combined?.cleanup();
  }

  if (res.status >= 300 && res.status < 400) {
    throw new Error(`reddit oauth endpoint returned an unexpected redirect (HTTP ${res.status})`);
  }
  if (res.status === 429) {
    const retryHeader = res.headers.get('retry-after');
    const retryAfter = retryHeader && /^\d+$/.test(retryHeader.trim()) ? parseInt(retryHeader.trim(), 10) : null;
    throw new RedditRateLimitError(retryAfter);
  }
  if (!res.ok) {
    throw new Error(`reddit API request failed with HTTP ${res.status}`);
  }

  const payload = await res.json();
  const mapped = mapPayload(payload, endpointPath);
  if (!mapped) return null;

  // The reddit-api tier serves clean structured content — there is no HTML.
  // We stash the rendered markdown in `html` so the downstream extractor's
  // markdown converter leaves it intact, and set method to the API label so the
  // response envelope reports fetch_method='reddit-api'. The structured
  // site_data is exposed via `mapRedditApiPayload` for callers that want the
  // richer record (RawFetchResult carries no site_data slot — that field is
  // produced by the extraction layer).
  return {
    url,
    finalUrl: url,
    html: mapped.markdown,
    contentType: 'text/markdown',
    statusCode: mapped.http_status,
    method: 'reddit-api',
    headers: {},
  };
}

/**
 * Public helper: map a raw Reddit API payload for a given endpoint path into
 * the structured RedditApiFetchResult (title / markdown / site_data). Exposed so
 * callers and tests can exercise the mapping without a live token round-trip.
 */
export function mapRedditApiPayload(payload: unknown, endpointPath: string): RedditApiFetchResult | null {
  return mapPayload(payload, endpointPath);
}
