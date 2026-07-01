import { describe, it, expect } from 'vitest';
import { canonicalizeUrl } from '../../../../src/search/core/canonical-url.js';

// S11c sub-area 2 — cross-engine canonical URL dedup.
//
// Raw-string dedup matched URLs literally. Two engines returning the same
// page through different URL variants (utm_*, AMP, mobile subdomain, trailing
// slash, http vs https) would surface as two results, breaking RRF fusion and
// over-counting consensus — a recall/quality flaw.
//
// canonicalizeUrl(url) MUST produce the same output for any pair of URLs the
// audit considers "the same page from the same canonical site".

describe('canonicalizeUrl — utm + tracking params', () => {
  it('drops utm_source and utm_medium from the canonical form', () => {
    const a = canonicalizeUrl('https://foo.com/x?utm_source=bar&utm_medium=newsletter');
    const b = canonicalizeUrl('https://foo.com/x');
    expect(a).toBe(b);
  });

  it('drops fbclid and gclid', () => {
    const a = canonicalizeUrl('https://foo.com/x?fbclid=abc');
    const b = canonicalizeUrl('https://foo.com/x?gclid=def');
    const c = canonicalizeUrl('https://foo.com/x');
    expect(a).toBe(c);
    expect(b).toBe(c);
  });

  it('preserves non-tracking query params', () => {
    const a = canonicalizeUrl('https://foo.com/x?id=42&utm_source=bar');
    const b = canonicalizeUrl('https://foo.com/x?id=42');
    expect(a).toBe(b);
    // The id=42 must still survive in the canonical form.
    expect(a).toContain('id=42');
  });
});

describe('canonicalizeUrl — AMP variants', () => {
  it('strips trailing /amp/ path segment', () => {
    expect(canonicalizeUrl('https://foo.com/x/amp/')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('strips leading /amp/ before the path', () => {
    expect(canonicalizeUrl('https://foo.com/amp/x')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('strips ?amp=1 query parameter', () => {
    expect(canonicalizeUrl('https://foo.com/x?amp=1')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('strips a .amp suffix on the path', () => {
    expect(canonicalizeUrl('https://foo.com/x.amp')).toBe(canonicalizeUrl('https://foo.com/x'));
  });
});

describe('canonicalizeUrl — mobile vs desktop subdomain', () => {
  it('treats m.foo.com as equivalent to foo.com', () => {
    expect(canonicalizeUrl('https://m.foo.com/x')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('treats mobile.foo.com as equivalent to foo.com', () => {
    expect(canonicalizeUrl('https://mobile.foo.com/x')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('does NOT collapse other subdomains (docs.foo.com stays distinct)', () => {
    // docs.foo.com is a separate site, not a mobile mirror. Keep distinct.
    expect(canonicalizeUrl('https://docs.foo.com/x')).not.toBe(canonicalizeUrl('https://foo.com/x'));
  });
});

describe('canonicalizeUrl — trailing slash + protocol normalization', () => {
  it('treats trailing-slash and no-trailing-slash as equivalent', () => {
    expect(canonicalizeUrl('https://foo.com/x/')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('treats http and https as equivalent', () => {
    expect(canonicalizeUrl('http://foo.com/x')).toBe(canonicalizeUrl('https://foo.com/x'));
  });

  it('combines protocol + trailing-slash + utm into a single canonical form', () => {
    expect(canonicalizeUrl('http://foo.com/x/?utm_source=bar')).toBe(
      canonicalizeUrl('https://foo.com/x'),
    );
  });

  it('drops www subdomain', () => {
    expect(canonicalizeUrl('https://www.foo.com/x')).toBe(canonicalizeUrl('https://foo.com/x'));
  });
});

describe('canonicalizeUrl — negative cases', () => {
  it('does NOT merge URLs with different paths', () => {
    expect(canonicalizeUrl('https://foo.com/x')).not.toBe(canonicalizeUrl('https://foo.com/y'));
  });

  it('does NOT merge different hosts', () => {
    expect(canonicalizeUrl('https://foo.com/x')).not.toBe(canonicalizeUrl('https://bar.com/x'));
  });

  it('returns the input string unchanged when URL cannot be parsed', () => {
    // Defensive: malformed URLs must not throw — dedup should still place them
    // on the same shelf as raw-string fallback.
    expect(canonicalizeUrl('not a url')).toBe('not a url');
    expect(canonicalizeUrl('')).toBe('');
  });
});
