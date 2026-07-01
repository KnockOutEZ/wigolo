// Integration test for P1: site-extractor structured-JSON passthrough on fetch().
//
// Why this file exists: slice-level unit tests pass at the extractor boundary,
// but the structured `SiteExtractionResult` shape (Reddit `comments[]`, YouTube
// `caption_tracks[]`, Amazon `asin`/`price`) was getting flattened into the
// markdown body of the `fetch()` response — never reaching callers as a JSON
// field. This file asserts the passthrough at the `handleFetch` boundary, the
// same surface MCP `tools/call: fetch` exercises.
//
// Pattern mirrors tests/unit/tools/fetch-mode.test.ts: stub the router with a
// captured fixture HTML and let the real extraction pipeline run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleFetch } from '../../src/tools/fetch.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import type { RawFetchResult } from '../../src/types.js';

const siteFixturesDir = join(import.meta.dirname, '..', 'fixtures', 'site-extractors');
const amazonFixturesDir = join(import.meta.dirname, '..', 'fixtures', 'amazon');
const load = (dir: string, name: string) => readFileSync(join(dir, name), 'utf-8');

function makeRouter(url: string, html: string): SmartRouter {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html,
    contentType: 'text/html; charset=utf-8',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  return {
    fetch: vi.fn().mockResolvedValue(raw),
  } as unknown as SmartRouter;
}

describe('integration: fetch surfaces site_data for reddit', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns site_data with subreddit / score / comments for a reddit thread URL', async () => {
    const html = load(siteFixturesDir, 'reddit-thread.html');
    const url =
      'https://old.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const site = r.data.site_data as Record<string, unknown> | undefined;
    expect(site).toBeDefined();
    expect(site).not.toBeNull();

    // Spec-mandated fields.
    expect(site!.subreddit).toBe('programming');
    expect(site!.author).toBe('ts_fan');
    expect(site!.score).toBe(2048);
    expect(typeof site!.upvote_ratio).toBe('number');
    expect((site!.upvote_ratio as number) >= 0 && (site!.upvote_ratio as number) <= 1).toBe(true);
    expect(typeof site!.body_markdown).toBe('string');
    expect((site!.body_markdown as string).length).toBeGreaterThan(0);
    expect(Array.isArray(site!.comments)).toBe(true);

    const comments = site!.comments as Array<{
      author: string;
      body: string;
      score: number;
      replies: unknown[];
    }>;
    expect(comments.length).toBeGreaterThanOrEqual(10);
    const first = comments[0]!;
    expect(typeof first.author).toBe('string');
    expect(typeof first.body).toBe('string');
    expect(typeof first.score).toBe('number');
    expect(Array.isArray(first.replies)).toBe(true);

    expect(Array.isArray(site!.awards)).toBe(true);
    expect(typeof site!.posted_at).toBe('string');
    expect(site!.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the human-readable markdown body intact alongside site_data (backwards compatible)', async () => {
    const html = load(siteFixturesDir, 'reddit-thread.html');
    const url =
      'https://old.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.markdown).toBeTruthy();
    expect(r.data.markdown).toMatch(/r\/programming/);
    expect(r.data.markdown.length).toBeGreaterThan(50);
  });
});

describe('integration: fetch surfaces site_data for youtube', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns site_data with video_id / caption_tracks / chapters for a youtube watch URL', async () => {
    const html = load(siteFixturesDir, 'youtube-watch-with-captions.html');
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const site = r.data.site_data as Record<string, unknown> | undefined;
    expect(site).toBeDefined();
    expect(site).not.toBeNull();

    // Spec-mandated fields.
    expect(site!.video_id).toBe('dQw4w9WgXcQ');
    expect(site!.channel).toBe('Example Channel');
    expect(typeof site!.duration).toBe('string');
    expect(site!.duration_seconds).toBe(642);
    expect(typeof site!.view_count).toBe('number');
    expect(site!.posted_at).toBe('2024-01-15T10:30:00Z');

    const captionTracks = site!.caption_tracks as Array<{
      language_code: string;
      base_url: string;
      kind: string;
      name: string;
    }>;
    expect(Array.isArray(captionTracks)).toBe(true);
    expect(captionTracks.length).toBeGreaterThan(0);
    // Validated youtube/googlevideo origin only — security regression guard.
    const captionHost = new URL(captionTracks[0]!.base_url).hostname;
    expect(
      captionHost.endsWith('youtube.com') || captionHost.endsWith('googlevideo.com'),
    ).toBe(true);

    const chapters = site!.chapters as Array<{ start: number; title: string }>;
    expect(Array.isArray(chapters)).toBe(true);
    expect(chapters.length).toBeGreaterThan(0);
    expect(typeof chapters[0]!.start).toBe('number');
    expect(typeof chapters[0]!.title).toBe('string');

    // C2 deferral — transcript is empty at sync extract time. Field must exist.
    expect(Array.isArray(site!.transcript)).toBe(true);
  });
});

describe('integration: fetch surfaces site_data for amazon', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns site_data with asin / price / features for an amazon dp URL', async () => {
    // Sandbox cannot fetch live Amazon (bot blocking). Captured fixture HTML
    // is the right call per the brief — the integration test is at the
    // handleFetch boundary, not the network boundary.
    const html = load(amazonFixturesDir, 'electronics.html');
    const url = 'https://www.amazon.com/dp/B08N5WRWNW/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const site = r.data.site_data as Record<string, unknown> | undefined;
    expect(site).toBeDefined();
    expect(site).not.toBeNull();

    // Spec-mandated fields.
    expect(site!.asin).toBe('B08N5WRWNW');
    expect(typeof site!.title).toBe('string');
    expect((site!.title as string).toLowerCase()).toContain('acme');
    expect((site!.brand as string).toLowerCase()).toContain('acme');
    expect(site!.price).toBeCloseTo(249.99, 2);
    expect(site!.currency).toBe('USD');
    expect(site!.rating).toBeCloseTo(4.5, 1);
    expect(site!.review_count).toBe(12438);
    expect(Array.isArray(site!.features)).toBe(true);
    expect((site!.features as string[]).length).toBeGreaterThan(0);
    expect(typeof site!.specifications).toBe('object');
    expect(Array.isArray(site!.images)).toBe(true);
    expect((site!.images as string[]).length).toBeGreaterThan(0);
    expect(site!.availability).toBe('in_stock');
  });
});

// Reddit "blocked by network security" responses
// were silently emitted with no site_data and no caller-visible signal — the
// caller could not tell whether the page actually had no site data or
// whether the bytes were a bot challenge. The extractor must short-circuit
// AND the fetch envelope must surface `fetch_failed: "blocked"`.
describe('integration: fetch surfaces fetch_failed=blocked when reddit is anti-bot blocked', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns NO site_data on a Reddit anti-bot challenge body (reddit pretending success)', async () => {
    const html = load(siteFixturesDir, 'reddit-blocked.html');
    const url =
      'https://old.reddit.com/r/programming/comments/abc123/blocked/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.site_data).toBeUndefined();
  });

  it('surfaces fetch_failed="blocked" on the envelope (reddit honest failure)', async () => {
    const html = load(siteFixturesDir, 'reddit-blocked.html');
    const url =
      'https://old.reddit.com/r/programming/comments/abc123/blocked/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.fetch_failed).toBe('blocked');
  });

  it('does NOT set fetch_failed on a real Reddit thread (no regression)', async () => {
    const html = load(siteFixturesDir, 'reddit-thread.html');
    const url =
      'https://old.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.fetch_failed).toBeUndefined();
    expect(r.data.site_data).toBeDefined();
  });
});

// Same as above for Amazon Page Not Found / anti-bot pages.
describe('integration: fetch surfaces fetch_failed=blocked when amazon is page-not-found', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns NO site_data on an Amazon Page Not Found body (amazon pretending success)', async () => {
    const html = load(amazonFixturesDir, 'blocked.html');
    const url = 'https://www.amazon.com/dp/B08N5WRWNW/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.site_data).toBeUndefined();
  });

  it('surfaces fetch_failed="blocked" on the envelope (amazon honest failure)', async () => {
    const html = load(amazonFixturesDir, 'blocked.html');
    const url = 'https://www.amazon.com/dp/B08N5WRWNW/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.fetch_failed).toBe('blocked');
  });

  it('does NOT set fetch_failed on a real Amazon product page (no regression)', async () => {
    const html = load(amazonFixturesDir, 'electronics.html');
    const url = 'https://www.amazon.com/dp/B08N5WRWNW/';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.fetch_failed).toBeUndefined();
    expect(r.data.site_data).toBeDefined();
  });
});

describe('integration: fetch omits site_data for non-site-extractor URLs', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('does not pollute the response with site_data on a generic HTML page', async () => {
    const html = `<!doctype html><html><head><title>Plain</title></head><body>
      <article><h1>Plain Article</h1>
      <p>${'Some body content used to satisfy extractor thresholds. '.repeat(20)}</p>
      </article></body></html>`;
    const url = 'https://example.com/article';
    const router = makeRouter(url, html);

    const r = await handleFetch({ url }, router);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.site_data).toBeUndefined();
  });
});
