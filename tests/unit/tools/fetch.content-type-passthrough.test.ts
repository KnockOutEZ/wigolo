// Tool-boundary cover for content-type passthrough.
//
// The unit tests pin the classifier and the extraction provider. This file
// asserts the behaviour a caller of the `fetch` tool actually observes, because
// that is where the defect was reported: `fetch` on a raw .md URL returned
// escaped markdown, and `fetch` on api.github.com returned prose.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn().mockReturnValue({ usable: false, stale: false }),
  normalizeUrl: (u: string) => u,
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

function makeRouter(url: string, html: string, contentType: string): SmartRouter {
  return {
    fetch: async () => ({
      url,
      finalUrl: url,
      html,
      contentType,
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const RAW_MD_URL = 'https://raw.githubusercontent.com/foo/bar/main/README.md';
const README = '# Project\n\nInstall with `npm i`.\n\n- option_one\n- option_two\n';

const API_URL = 'https://api.github.com/repos/foo/bar';
const API_JSON = JSON.stringify({ full_name: 'foo/bar', node_id: 'abc', stars: 3 }, null, 2);

describe('fetch tool — content-type passthrough', () => {
  it('returns a raw .md body verbatim instead of backslash-escaped markdown', async () => {
    const result = await handleFetch(
      { url: RAW_MD_URL, force_refresh: true, include_full_markdown: true },
      makeRouter(RAW_MD_URL, README, 'text/plain; charset=utf-8'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.markdown).toBe(README);
    expect(result.data.markdown).not.toContain('\\#');
    expect(result.data.markdown).not.toContain('option\\_one');
  });

  it('returns an application/json body as parseable JSON, not prose', async () => {
    const result = await handleFetch(
      { url: API_URL, force_refresh: true, include_full_markdown: true },
      makeRouter(API_URL, API_JSON, 'application/json; charset=utf-8'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.markdown).toBe(API_JSON);
    expect(() => JSON.parse(result.data.markdown ?? '')).not.toThrow();
    expect(result.data.links).toEqual([]);
  });

  it('still extracts ordinary HTML pages through the content extractor', async () => {
    const url = 'https://example.com/article';
    const html =
      '<html><head><title>An Article</title></head><body><main><h1>Headline</h1>' +
      '<p>Body copy long enough for the extractor to treat it as the article region ' +
      'and convert it into markdown as it always has.</p></main></body></html>';

    const result = await handleFetch(
      { url, force_refresh: true, include_full_markdown: true },
      makeRouter(url, html, 'text/html; charset=utf-8'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.markdown).toContain('# Headline');
    expect(result.data.markdown).not.toContain('<h1>');
  });
});
