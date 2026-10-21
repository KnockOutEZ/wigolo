import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';
import {
  normalizeUrlForDedup,
  dedupAgainstRecentUrls,
  shouldLowercasePathForHost,
} from '../../../../src/search/core/recent-cache-dedup.js';

function makeResult(url: string, title = 't'): RawSearchResult {
  return {
    title,
    url,
    snippet: 's',
    relevance_score: 1,
    engine: 'mock',
  };
}

describe('normalizeUrlForDedup', () => {
  it('lowercases the host', () => {
    expect(normalizeUrlForDedup('https://EXAMPLE.com/foo')).toBe(
      'https://example.com/foo',
    );
  });

  it('strips trailing slash on path', () => {
    expect(normalizeUrlForDedup('https://example.com/foo/')).toBe(
      'https://example.com/foo',
    );
  });

  it('normalizes root path', () => {
    expect(normalizeUrlForDedup('https://example.com/')).toBe(
      'https://example.com',
    );
  });

  it('drops the fragment', () => {
    expect(normalizeUrlForDedup('https://example.com/p#section')).toBe(
      'https://example.com/p',
    );
  });

  it('drops utm_* / gclid / fbclid params', () => {
    expect(
      normalizeUrlForDedup(
        'https://example.com/p?utm_source=x&gclid=y&fbclid=z&keep=1',
      ),
    ).toBe('https://example.com/p?keep=1');
  });

  it('drops tracking params regardless of case (#633)', () => {
    expect(
      normalizeUrlForDedup(
        'https://example.com/p?UTM_Source=x&Utm_Medium=m&GCLID=y&FbClid=z&Keep=1',
      ),
    ).toBe('https://example.com/p?Keep=1');
  });

  it('sorts remaining params alphabetically', () => {
    expect(normalizeUrlForDedup('https://example.com/p?b=2&a=1')).toBe(
      'https://example.com/p?a=1&b=2',
    );
  });

  it('strips default port 443 for https', () => {
    expect(normalizeUrlForDedup('https://example.com:443/p')).toBe(
      'https://example.com/p',
    );
  });

  it('strips default port 80 for http', () => {
    expect(normalizeUrlForDedup('http://example.com:80/p')).toBe(
      'http://example.com/p',
    );
  });

  it('throws on malformed URL', () => {
    expect(() => normalizeUrlForDedup('not a url')).toThrow();
  });
});

describe('dedupAgainstRecentUrls', () => {
  it('returns input unchanged when recent_urls is undefined', () => {
    const results = [makeResult('https://example.com/a')];
    expect(dedupAgainstRecentUrls(results, undefined)).toBe(results);
  });

  it('returns input unchanged when recent_urls is empty', () => {
    const results = [makeResult('https://example.com/a')];
    expect(dedupAgainstRecentUrls(results, [])).toBe(results);
  });

  it('drops an exact URL match', () => {
    const results = [
      makeResult('https://example.com/a'),
      makeResult('https://example.com/b'),
    ];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out.map((r) => r.url)).toEqual(['https://example.com/b']);
  });

  it('drops a result whose URL only differs by trailing slash', () => {
    const results = [makeResult('https://example.com/a/')];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(0);
  });

  it('drops a result whose URL only differs by fragment', () => {
    const results = [makeResult('https://example.com/a#section')];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(0);
  });

  it('drops a result whose URL only differs by utm params', () => {
    const results = [
      makeResult('https://example.com/a?utm_source=newsletter'),
    ];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(0);
  });

  it('keeps a result on a different domain', () => {
    const results = [makeResult('https://other.com/a')];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(1);
  });

  it('keeps a result with a different path', () => {
    const results = [makeResult('https://example.com/b')];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(1);
  });

  it('ignores malformed URLs in recent_urls gracefully', () => {
    const results = [makeResult('https://example.com/a')];
    const out = dedupAgainstRecentUrls(results, [
      'not a url',
      'https://example.com/a',
    ]);
    expect(out).toHaveLength(0);
  });

  it('keeps a result with a malformed URL even when dedup list is present', () => {
    const results = [makeResult('::::not-a-url::::')];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(1);
  });

  it('drops only the matching subset when multiple recent URLs partially overlap', () => {
    const results = [
      makeResult('https://example.com/a'),
      makeResult('https://example.com/b'),
      makeResult('https://example.com/c'),
    ];
    const out = dedupAgainstRecentUrls(results, [
      'https://example.com/a',
      'https://example.com/c',
    ]);
    expect(out.map((r) => r.url)).toEqual(['https://example.com/b']);
  });

  it('handles host case-fold between result and recent URL', () => {
    const results = [makeResult('https://Example.COM/a')];
    const out = dedupAgainstRecentUrls(results, ['https://example.com/a']);
    expect(out).toHaveLength(0);
  });

  it('returns input unchanged when recent_urls contains only malformed entries', () => {
    const results = [makeResult('https://example.com/a')];
    const out = dedupAgainstRecentUrls(results, ['not a url', 'also bad']);
    expect(out).toBe(results);
  });
});

describe('case-insensitive path normalization', () => {
  const ORIGINAL_ENV = process.env.WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS;

  beforeEach(() => {
    delete process.env.WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS;
    } else {
      process.env.WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS = ORIGINAL_ENV;
    }
  });

  it('lowercases paths on the default microsoft.com allowlist', () => {
    expect(
      normalizeUrlForDedup('https://learn.microsoft.com/en-us/Azure/Topic'),
    ).toBe('https://learn.microsoft.com/en-us/azure/topic');
  });

  it('lowercases paths on archive.org', () => {
    expect(normalizeUrlForDedup('https://web.archive.org/Web/2024/X')).toBe(
      'https://web.archive.org/web/2024/x',
    );
  });

  it('matches parent-domain suffixes (any.subdomain.microsoft.com)', () => {
    expect(
      normalizeUrlForDedup('https://Tech.MICROSOFT.com/Docs/Foo'),
    ).toBe('https://tech.microsoft.com/docs/foo');
  });

  it('preserves case on case-sensitive hosts like github.com', () => {
    expect(normalizeUrlForDedup('https://github.com/KnockOutEZ/Repo')).toBe(
      'https://github.com/KnockOutEZ/Repo',
    );
  });

  it('honors WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS env extension', () => {
    process.env.WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS = 'mysite.example';
    expect(normalizeUrlForDedup('https://mysite.example/A/B')).toBe(
      'https://mysite.example/a/b',
    );
  });

  it('shouldLowercasePathForHost is true for default allowlist hosts', () => {
    expect(shouldLowercasePathForHost('learn.microsoft.com')).toBe(true);
    expect(shouldLowercasePathForHost('archive.org')).toBe(true);
    expect(shouldLowercasePathForHost('github.com')).toBe(false);
  });

  it('dedups case-different paths on case-insensitive hosts', () => {
    const results = [makeResult('https://learn.microsoft.com/EN-US/Azure')];
    const out = dedupAgainstRecentUrls(results, [
      'https://learn.microsoft.com/en-us/azure',
    ]);
    expect(out).toHaveLength(0);
  });

  it('does NOT dedup case-different paths on github.com', () => {
    const results = [makeResult('https://github.com/Anthropic/sdk')];
    const out = dedupAgainstRecentUrls(results, [
      'https://github.com/anthropic/sdk',
    ]);
    expect(out).toHaveLength(1);
  });
});
