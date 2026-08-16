import { describe, it, expect, vi, beforeEach } from 'vitest';

// Companion to defuddle-no-third-party-egress.test.ts.
//
// That file sweeps behaviour: it proves no request leaves the process for any
// site the bundled extractor knows about TODAY. This file asserts the mechanism
// instead — that wigolo's single call site hands the library its own
// third-party-egress switch, on every call, whatever the input.
//
// The distinction is the whole point. A behavioural sweep can only cover
// extractors that already exist; if a future release adds an async extractor
// for a site nobody has thought of, only the switch protects the user. So the
// switch is asserted directly rather than inferred from the destinations that
// happened to be reachable when the defect was found.

const calls: Array<{ url: string; options: unknown }> = [];

vi.mock('defuddle/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('defuddle/node')>();
  return {
    ...actual,
    Defuddle: async (html: string, url: string, options?: unknown) => {
      calls.push({ url, options });
      return actual.Defuddle(html, url, options as never);
    },
  };
});

const { defuddleExtract } = await import('../../../src/extraction/defuddle.js');

const LONG_ARTICLE = `<!doctype html><html><head><title>Post</title></head><body>
  <article><h1>Post</h1>${'<p>Body copy long enough to clear the wrapper content threshold.</p>'.repeat(
    8,
  )}</article></body></html>`;

describe('defuddleExtract disables the async third-party extractor class', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('passes useAsync:false on a page that extracts successfully', async () => {
    const result = await defuddleExtract(LONG_ARTICLE, 'https://example.com/post');
    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(
      calls[0].options,
      'the extractor was called with no options — the third-party switch is not being set',
    ).toBeDefined();
    expect(calls[0].options).toMatchObject({ useAsync: false });
  });

  it('passes useAsync:false on a page with no extractable content', async () => {
    // The zero-word case is exactly when the library used to reach for the
    // network, so the switch must be present here above all.
    await defuddleExtract('<html><body><div id="root"></div></body></html>', 'https://x.com/a/status/1');
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ useAsync: false });
  });

  it('passes useAsync:false even when the input makes the parse throw', async () => {
    await defuddleExtract('not html at all', 'https://example.com/');
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ useAsync: false });
  });
});
