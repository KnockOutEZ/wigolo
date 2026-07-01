import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  redditExtractor,
  extractRedditThread,
} from '../../../../src/extraction/site-extractors/reddit.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/site-extractors');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const THREAD_HTML = loadFixture('reddit-thread.html');
const DELETED_POST_HTML = loadFixture('reddit-deleted-post.html');
const DELETED_COMMENTS_HTML = loadFixture('reddit-deleted-comments.html');

describe('redditExtractor.canHandle', () => {
  it('matches www.reddit.com thread URLs', () => {
    expect(
      redditExtractor.canHandle(
        'https://www.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/',
      ),
    ).toBe(true);
  });

  it('matches reddit.com (no www)', () => {
    expect(
      redditExtractor.canHandle('https://reddit.com/r/programming/comments/abc123/title/'),
    ).toBe(true);
  });

  it('matches old.reddit.com thread URLs', () => {
    expect(
      redditExtractor.canHandle('https://old.reddit.com/r/movies/comments/xyz789/some_title/'),
    ).toBe(true);
  });

  it('matches np.reddit.com (no participation) subdomain', () => {
    expect(
      redditExtractor.canHandle('https://np.reddit.com/r/movies/comments/xyz789/'),
    ).toBe(true);
  });

  it('matches redd.it short URLs', () => {
    expect(redditExtractor.canHandle('https://redd.it/abc123')).toBe(true);
  });

  it('does not match the front page (no /comments/ segment)', () => {
    expect(redditExtractor.canHandle('https://www.reddit.com/r/programming/')).toBe(false);
  });

  it('does not match GitHub URLs', () => {
    expect(redditExtractor.canHandle('https://github.com/owner/repo/issues/1')).toBe(false);
  });

  it('does not match arbitrary URLs that mention reddit in the path', () => {
    expect(redditExtractor.canHandle('https://example.com/reddit/comments/abc/')).toBe(false);
  });

  it('does not throw on malformed URLs', () => {
    expect(redditExtractor.canHandle('not a url')).toBe(false);
  });
});

describe('redditExtractor.extract — happy path', () => {
  const url =
    'https://old.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/';

  it('returns a non-null result', () => {
    expect(redditExtractor.extract(THREAD_HTML, url)).not.toBeNull();
  });

  it('uses extractor: site-specific (regression: must not silently fall back)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });

  it('extracts the thread title (regression: empty title indicates DOM-shape change)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.title).toContain("What's your favorite TypeScript trick?");
  });

  it('exposes the post author in metadata (downstream agents key off this)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.metadata.author).toBe('ts_fan');
  });

  it('exposes the post date in metadata (ISO 8601 — agents date-sort on this)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.metadata.date).toBe('2026-05-20T12:34:56+00:00');
  });

  it('emits the subreddit name into the markdown header (regression: routing tags use this)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.markdown).toMatch(/r\/programming/);
  });

  it('includes the post body in markdown (otherwise post context is lost)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.markdown).toContain('satisfies');
  });

  it('renders at least 10 comments in the markdown (spec: top-N comments)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    const commentBlocks = result.markdown.match(/^### /gm) ?? [];
    expect(commentBlocks.length).toBeGreaterThanOrEqual(10);
  });

  it('renders the highest-voted comment first (regression: ordering signal lost on layout change)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    const firstAuthorMatch = result.markdown.match(/^### .*?u\/(\w+)/m);
    expect(firstAuthorMatch?.[1]).toBe('type_guru');
  });

  it('includes per-comment vote scores (regression: agents rank-merge on score)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.markdown).toContain('512');
    expect(result.markdown).toContain('318');
  });

  it('preserves inline code in comment bodies (regression: <code> handling)', () => {
    const result = redditExtractor.extract(THREAD_HTML, url)!;
    expect(result.markdown).toContain('as const');
  });
});

describe('extractRedditThread — structured output (spec shape)', () => {
  const url =
    'https://old.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/';

  it('returns the spec-defined fields with correct types', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(typeof t.title).toBe('string');
    expect(typeof t.author).toBe('string');
    expect(typeof t.subreddit).toBe('string');
    expect(typeof t.body_markdown).toBe('string');
    expect(Array.isArray(t.comments)).toBe(true);
    expect(typeof t.score).toBe('number');
    expect(typeof t.upvote_ratio).toBe('number');
    expect(Array.isArray(t.awards)).toBe(true);
    expect(typeof t.posted_at).toBe('string');
  });

  it('populates subreddit name without the r/ prefix', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(t.subreddit).toBe('programming');
  });

  it('parses score from the post score element (regression: 0 means parse broke)', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(t.score).toBe(2048);
  });

  it('returns upvote_ratio in [0, 1] range (defaults to 1 when absent)', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(t.upvote_ratio).toBeGreaterThanOrEqual(0);
    expect(t.upvote_ratio).toBeLessThanOrEqual(1);
  });

  it('captures at least 10 top-level comments with author + body + score', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(t.comments.length).toBeGreaterThanOrEqual(10);
    const first = t.comments[0]!;
    expect(first.author).toBeTruthy();
    expect(first.body).toBeTruthy();
    expect(typeof first.score).toBe('number');
    expect(Array.isArray(first.replies)).toBe(true);
  });

  it('sorts comments by score descending (regression: order is product-visible)', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    const scores = t.comments.map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  it('emits posted_at as ISO 8601 (regression: agents date-sort on this)', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(t.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('captures award labels when present', () => {
    const t = extractRedditThread(THREAD_HTML, url)!;
    expect(t.awards.length).toBeGreaterThan(0);
  });
});

describe('redditExtractor — deleted post', () => {
  const url = 'https://old.reddit.com/r/AskReddit/comments/del123/removed/';

  it('does not throw on deleted post HTML', () => {
    expect(() => redditExtractor.extract(DELETED_POST_HTML, url)).not.toThrow();
  });

  it('returns a non-null result even when post body is removed', () => {
    expect(redditExtractor.extract(DELETED_POST_HTML, url)).not.toBeNull();
  });

  it('marks the body as deleted/removed in the structured output', () => {
    const t = extractRedditThread(DELETED_POST_HTML, url)!;
    expect(t.body_markdown).toMatch(/\[(deleted|removed)\]/i);
  });

  it('preserves comments under a deleted post (agents still need the comment thread)', () => {
    const t = extractRedditThread(DELETED_POST_HTML, url)!;
    expect(t.comments.length).toBeGreaterThan(0);
  });

  it('records author as [deleted] when the OP is gone', () => {
    const t = extractRedditThread(DELETED_POST_HTML, url)!;
    expect(t.author).toBe('[deleted]');
  });
});

describe('redditExtractor — deleted comments', () => {
  const url = 'https://old.reddit.com/r/movies/comments/xyz789/what_is_the_worst_movie_sequel/';

  it('does not throw when some comments are deleted', () => {
    expect(() => redditExtractor.extract(DELETED_COMMENTS_HTML, url)).not.toThrow();
  });

  it('still extracts the live (non-deleted) comments', () => {
    const t = extractRedditThread(DELETED_COMMENTS_HTML, url)!;
    const liveAuthors = t.comments.map((c) => c.author).filter((a) => a !== '[deleted]');
    expect(liveAuthors).toContain('film_buff');
    expect(liveAuthors).toContain('movie_critic');
  });

  it('marks deleted comments with [deleted] body rather than dropping them silently', () => {
    const t = extractRedditThread(DELETED_COMMENTS_HTML, url)!;
    const deleted = t.comments.filter((c) => c.body === '[deleted]' || c.author === '[deleted]');
    expect(deleted.length).toBeGreaterThan(0);
  });
});

describe('redditExtractor — edge cases', () => {
  it('returns null for empty HTML', () => {
    expect(
      redditExtractor.extract('', 'https://www.reddit.com/r/x/comments/1/y/'),
    ).toBeNull();
  });

  it('returns null when no recognizable Reddit thread structure exists', () => {
    expect(
      redditExtractor.extract(
        '<html><body><p>Nothing here</p></body></html>',
        'https://www.reddit.com/r/x/comments/1/y/',
      ),
    ).toBeNull();
  });
});

// Reddit anti-bot pages were previously silently treated as
// regular reddit responses — no site_data emitted, no signal to caller.
// Detect the block string and refuse to produce fake site_data.
describe('redditExtractor — anti-bot block detection', () => {
  const BLOCKED_HTML = loadFixture('reddit-blocked.html');
  const url =
    'https://old.reddit.com/r/programming/comments/abc123/something/';

  it('detectAntiBotBlock returns "blocked" for a Reddit anti-bot challenge body', async () => {
    const { detectAntiBotBlock } = await import(
      '../../../../src/extraction/site-extractors/reddit.js'
    );
    expect(detectAntiBotBlock(BLOCKED_HTML)).toBe('blocked');
  });

  it('detectAntiBotBlock returns null for a real Reddit thread (no false positive)', async () => {
    const { detectAntiBotBlock } = await import(
      '../../../../src/extraction/site-extractors/reddit.js'
    );
    expect(detectAntiBotBlock(THREAD_HTML)).toBeNull();
  });

  it('extract returns null on a blocked body (must not pretend success)', () => {
    expect(redditExtractor.extract(BLOCKED_HTML, url)).toBeNull();
  });
});
