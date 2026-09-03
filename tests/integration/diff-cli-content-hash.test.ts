import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';
import { executeDiff } from '../../src/repl/commands/diff.js';
import { resetConfig } from '../../src/config.js';
import type { ReplDeps } from '../../src/repl/commands/types.js';
import type { RawFetchResult, ExtractionResult } from '../../src/types.js';

/**
 * K16 end to end: the CLI flag against the REAL store, not a mocked handler.
 *
 * The unit tests around `executeDiff` mock `handleDiff`, so they pin the
 * argument shape and nothing about resolution; the unit tests around
 * resolution call `handleDiff` directly, so they never see the flag. Neither
 * can fail if the CLI hands down a hash the store cannot resolve — which is
 * exactly the seam K16 adds. These run the flag through the same
 * `cacheContent` writer a `fetch` uses, so a body that is no longer live is
 * genuinely reached off `url_versions`.
 *
 * No network: the right-hand side is inline, so `handleFetch` is never called.
 */

const URL = 'https://example.com/hash-cli';

const BODY_LIVE = '# Page\n\nThe body it serves now.\n';
const BODY_PAST = '# Page\n\nThe body it served before.\n';

function hashOf(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>hello</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(markdown: string): ExtractionResult {
  return {
    title: 'Hash CLI Page',
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
}

function write(markdown: string): void {
  cacheContent(makeRaw(URL), makeExtraction(markdown));
}

function deps(): ReplDeps {
  return {
    router: {} as ReplDeps['router'],
    engines: [],
    backendStatus: {} as ReplDeps['backendStatus'],
  };
}

describe('wigolo diff --old-hash over the real store', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('resolves a hash the live row no longer carries', async () => {
    write(BODY_PAST);
    write(BODY_LIVE);

    const result = await executeDiff(
      {
        command: 'diff',
        positional: [],
        flags: { 'old-hash': hashOf(BODY_PAST), new: BODY_LIVE },
      },
      deps(),
    );

    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.unified_diff).toContain('The body it served before');
    expect(result.unified_diff).toContain('The body it serves now');
  });

  it('still resolves a hash that IS the live row', async () => {
    // The flag is not a version-only path. A caller holding the fingerprint of
    // a page that has not changed since must get the same answer, or the
    // advice "pass the hash fetch printed" would hold only after a change.
    write(BODY_LIVE);

    const result = await executeDiff(
      {
        command: 'diff',
        positional: [],
        flags: { 'old-hash': hashOf(BODY_LIVE), new: BODY_LIVE },
      },
      deps(),
    );

    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  it('misses honestly for a well-formed hash nothing carries', async () => {
    // K31 is a deliberate trade: the version store is byte-bounded and evicts
    // oldest-first across every URL, so absence is "not retained", never "never
    // existed" — and never the live body dressed up as the past one.
    write(BODY_LIVE);

    const result = await executeDiff(
      {
        command: 'diff',
        positional: [],
        flags: { 'old-hash': hashOf('a body this machine never saw\n'), new: BODY_LIVE },
      },
      deps(),
    );

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/no retained version carries it/i);
    expect(result.error).toMatch(/evicted/i);
    expect(result.error).not.toMatch(/never (existed|fetched|seen)/i);
    expect(result.unified_diff).toBeUndefined();
  });

  it('rejects a malformed hash as input, with no retention story attached', async () => {
    write(BODY_LIVE);

    const result = await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': 'deadbeef', new: BODY_LIVE } },
      deps(),
    );

    expect(result.error).toContain('64');
    expect(result.error).not.toMatch(/retain|evict/i);
  });
});
