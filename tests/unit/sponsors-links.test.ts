import { describe, it, expect } from 'vitest';
// The sponsor registry lives in the site package (it is rendered by the site
// and mirrored into the README). It is deliberately framework-free so the
// tracked-link contract can be tested here, in the repo's only test runner.
import {
  PLACEMENTS,
  SPONSORS,
  UNKNOWN_PLACEMENT,
  getSponsor,
  normalizePlacement,
  sponsorCountPath,
  sponsorGoPath,
  sponsorGoUrl,
  sponsorTargetUrl,
  type Sponsor,
} from '../../site/src/lib/sponsors';

const testmu = (): Sponsor => {
  const s = getSponsor('testmu');
  if (!s) throw new Error('testmu sponsor missing from the registry');
  return s;
};

describe('sponsor registry', () => {
  it('keeps the destination the sponsor actually contracted for', () => {
    // These two UTMs were specified by the sponsor and their reporting keys on
    // them. If a future edit rewrites the URL, their attribution silently goes
    // to zero and we would only find out at renewal.
    const url = new URL(testmu().url);
    expect(url.origin + url.pathname).toBe('https://www.testmuai.com/');
    expect(url.searchParams.get('utm_source')).toBe('wigolo');
    expect(url.searchParams.get('utm_medium')).toBe('opensourcecollab');
  });

  it('gives every sponsor a slug usable as a path segment and both logo themes', () => {
    for (const s of SPONSORS) {
      // The slug becomes /go/<slug>/ on a static host and an analytics path.
      expect(s.slug).toMatch(/^[a-z0-9-]+$/);
      // A single-theme logo goes invisible on one of GitHub's two themes.
      expect(s.logo.light).not.toBe(s.logo.dark);
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('sponsorTargetUrl', () => {
  it('tags the placement so README and site clicks are separable', () => {
    // This is the whole point of the hop: at renewal we need to say which
    // surface produced the traffic, not just that traffic happened.
    const readme = new URL(sponsorTargetUrl(testmu(), 'readme'));
    const home = new URL(sponsorTargetUrl(testmu(), 'site-home'));
    expect(readme.searchParams.get('utm_content')).toBe('readme');
    expect(home.searchParams.get('utm_content')).toBe('site-home');
  });

  it("preserves the sponsor's own UTMs while tagging", () => {
    const url = new URL(sponsorTargetUrl(testmu(), 'readme'));
    expect(url.searchParams.get('utm_source')).toBe('wigolo');
    expect(url.searchParams.get('utm_medium')).toBe('opensourcecollab');
  });

  it('adds utm_content exactly once, never duplicating a param', () => {
    const query = new URL(sponsorTargetUrl(testmu(), 'readme')).searchParams;
    expect(query.getAll('utm_content')).toHaveLength(1);
  });

  it('defers to a utm_content the sponsor set themselves', () => {
    // If a sponsor ships a URL that already carries utm_content, that value is
    // load-bearing in their funnel; overwriting it would corrupt their data.
    const withContent: Sponsor = {
      ...testmu(),
      url: 'https://example.com/?utm_source=wigolo&utm_content=their-own-campaign',
    };
    const url = new URL(sponsorTargetUrl(withContent, 'readme'));
    expect(url.searchParams.get('utm_content')).toBe('their-own-campaign');
  });
});

describe('normalizePlacement', () => {
  it('accepts every placement we actually publish', () => {
    // Guards against a link being tagged with a ref the normalizer rejects,
    // which would silently collapse that surface into "unknown".
    for (const p of PLACEMENTS) {
      expect(normalizePlacement(p)).toBe(p);
    }
  });

  it('refuses an unpublished ref instead of reflecting it', () => {
    // `ref` comes from the query string, so it is attacker-supplied. It flows
    // into an outbound URL and into our analytics path; reflecting it verbatim
    // would let anyone forge placements, pollute the sponsor's reporting, and
    // smuggle arbitrary text into both.
    for (const hostile of [
      'evil',
      '../../etc/passwd',
      'readme&utm_source=attacker',
      'readme ',
      'README',
      '<script>alert(1)</script>',
      'https://attacker.example',
      '',
      null,
      undefined,
    ]) {
      expect(normalizePlacement(hostile)).toBe(UNKNOWN_PLACEMENT);
    }
  });

  it('cannot inject extra query params into the sponsor destination', () => {
    const placement = normalizePlacement('readme&utm_medium=hijacked');
    const url = new URL(sponsorTargetUrl(testmu(), placement));
    expect(url.searchParams.get('utm_medium')).toBe('opensourcecollab');
    expect(url.searchParams.get('utm_content')).toBe(UNKNOWN_PLACEMENT);
  });
});

describe('hop URLs', () => {
  it('builds a site-relative path carrying the placement', () => {
    expect(sponsorGoPath('testmu', 'readme')).toBe('/go/testmu/?ref=readme');
  });

  it('builds an absolute URL for surfaces GitHub serves', () => {
    // A relative link in the README would resolve against github.com and 404,
    // so README links must be absolute.
    expect(sponsorGoUrl('testmu', 'readme', 'https://knockoutez.github.io/wigolo')).toBe(
      'https://knockoutez.github.io/wigolo/go/testmu/?ref=readme',
    );
  });

  it('does not double the slash when the site URL has a trailing one', () => {
    expect(sponsorGoUrl('testmu', 'readme', 'https://knockoutez.github.io/wigolo/')).toBe(
      'https://knockoutez.github.io/wigolo/go/testmu/?ref=readme',
    );
  });

  it('keeps the counted path free of the query string', () => {
    // GoatCounter groups by path; leaving `?ref=` in would fragment one
    // placement across every stray param a visitor arrives with.
    const path = sponsorCountPath('testmu', 'readme');
    expect(path).toBe('/go/testmu/readme');
    expect(path).not.toContain('?');
  });
});
