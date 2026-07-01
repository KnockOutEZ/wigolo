import { describe, it, expect } from 'vitest';
import { isPrivateUrl, matchesPatterns, canonicalForCrawl, stripFragment, canonicalForOutput } from '../../../src/crawl/url-utils.js';

describe('canonicalForCrawl', () => {
  it('strips fragment', () => {
    expect(canonicalForCrawl('https://hono.dev/docs#VPContent')).toBe('https://hono.dev/docs');
  });
  it('strips trailing slash', () => {
    expect(canonicalForCrawl('https://hono.dev/docs/')).toBe('https://hono.dev/docs');
  });
  it('keeps root slash', () => {
    expect(canonicalForCrawl('https://hono.dev/')).toBe('https://hono.dev/');
  });
  it('returns input on bad URL', () => {
    expect(canonicalForCrawl('not a url')).toBe('not a url');
  });
});

describe('stripFragment', () => {
  it('removes the hash fragment', () => {
    expect(stripFragment('https://x.com/intro#section-a')).toBe('https://x.com/intro');
  });
  it('removes an empty hash', () => {
    expect(stripFragment('https://x.com/intro#')).toBe('https://x.com/intro');
  });
  it('leaves URLs without a fragment unchanged', () => {
    expect(stripFragment('https://x.com/intro')).toBe('https://x.com/intro');
  });
  it('preserves query parameters', () => {
    expect(stripFragment('https://x.com/intro?q=1#a')).toBe('https://x.com/intro?q=1');
  });
  it('returns input on bad URL', () => {
    expect(stripFragment('not a url')).toBe('not a url');
  });
});

describe('canonicalForOutput strips fragments', () => {
  // BFS pages[] contained two `/intro` entries
  // because the emitted URL kept anchor fragments. Anchors are intra-page
  // navigation, not page identity — strip them on emission so the result
  // shape matches what callers expect.
  it('drops anchor fragments', () => {
    expect(canonicalForOutput('https://x.com/intro#welcome')).toBe('https://x.com/intro');
  });
  it('drops fragment together with trailing slash', () => {
    expect(canonicalForOutput('https://x.com/intro/#section')).toBe('https://x.com/intro');
  });
});

describe('isPrivateUrl', () => {
  it('detects localhost', () => {
    expect(isPrivateUrl('http://localhost:3000/docs')).toBe(true);
    expect(isPrivateUrl('http://localhost/page')).toBe(true);
  });

  it('detects 127.0.0.1', () => {
    expect(isPrivateUrl('http://127.0.0.1:8080/api')).toBe(true);
  });

  it('detects ::1 (IPv6 loopback)', () => {
    expect(isPrivateUrl('http://[::1]:3000/docs')).toBe(true);
  });

  it('detects 192.168.x.x', () => {
    expect(isPrivateUrl('http://192.168.1.100:8080')).toBe(true);
    expect(isPrivateUrl('http://192.168.0.1/page')).toBe(true);
  });

  it('detects 10.x.x.x', () => {
    expect(isPrivateUrl('http://10.0.0.5:3000/docs')).toBe(true);
  });

  it('detects 172.16.0.0/12 range', () => {
    expect(isPrivateUrl('http://172.16.0.1/page')).toBe(true);
    expect(isPrivateUrl('http://172.31.255.255/page')).toBe(true);
    expect(isPrivateUrl('http://172.32.0.1/page')).toBe(false);
  });

  it('detects 0.0.0.0', () => {
    expect(isPrivateUrl('http://0.0.0.0:8080/docs')).toBe(true);
  });

  it('detects .local domains', () => {
    expect(isPrivateUrl('http://myserver.local:8080/docs')).toBe(true);
  });

  it('returns false for public URLs', () => {
    expect(isPrivateUrl('https://docs.example.com')).toBe(false);
    expect(isPrivateUrl('https://github.com/repo')).toBe(false);
  });
});

describe('matchesPatterns', () => {
  it('returns true when no patterns are specified', () => {
    expect(matchesPatterns('https://example.com/docs/intro', undefined, undefined)).toBe(true);
  });

  it('matches include_patterns (regex)', () => {
    expect(matchesPatterns('https://example.com/docs/intro', ['/docs/'], undefined)).toBe(true);
    expect(matchesPatterns('https://example.com/blog/post', ['/docs/'], undefined)).toBe(false);
  });

  it('rejects exclude_patterns (regex)', () => {
    expect(matchesPatterns('https://example.com/docs/intro', undefined, ['/blog/'])).toBe(true);
    expect(matchesPatterns('https://example.com/blog/post', undefined, ['/blog/'])).toBe(false);
  });

  it('applies both include and exclude (include first, then exclude)', () => {
    expect(matchesPatterns('https://example.com/docs/changelog', ['/docs/'], ['/changelog'])).toBe(false);
    expect(matchesPatterns('https://example.com/docs/intro', ['/docs/'], ['/changelog'])).toBe(true);
  });

  it('handles regex special characters in patterns', () => {
    expect(matchesPatterns('https://example.com/v2.0/docs', ['v2\\.0'], undefined)).toBe(true);
    expect(matchesPatterns('https://example.com/v2X0/docs', ['v2\\.0'], undefined)).toBe(false);
  });
});
