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
  sponsorGoPath,
  sponsorGoUrl,
  sponsorReleaseLine,
  sponsorTargetUrl,
  type Sponsor,
} from '../../site/src/lib/sponsors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    expect(sponsorGoUrl('testmu', 'readme', 'https://wigolo.app')).toBe(
      'https://wigolo.app/go/testmu/?ref=readme',
    );
  });

  it('does not double the slash when the site URL has a trailing one', () => {
    expect(sponsorGoUrl('testmu', 'readme', 'https://wigolo.app/')).toBe(
      'https://wigolo.app/go/testmu/?ref=readme',
    );
  });

});

describe('published sponsor links', () => {
  it('tag every README and SPONSORS.md hop with a known sponsor and a published placement', () => {
    // A typo'd ref would pass the redirect but collapse that surface into
    // "unknown" — its clicks would vanish from the sponsor's report.
    const hops = ['README.md', 'SPONSORS.md'].flatMap((f) =>
      [...readFileSync(join(process.cwd(), f), 'utf8').matchAll(/\/go\/([a-z0-9-]+)\/\?ref=([a-z0-9-]+)/g)].map(
        (m) => ({ file: f, slug: m[1], ref: m[2] }),
      ),
    );
    expect(hops.length).toBeGreaterThan(0);
    for (const h of hops) {
      expect(getSponsor(h.slug), `${h.file}: ${h.slug}`).toBeDefined();
      expect(normalizePlacement(h.ref), `${h.file}: ${h.ref}`).toBe(h.ref);
    }
  });

  it('puts the README top strip above the fold, before the first section', () => {
    // The strip is only worth selling if it sits in the header block, not
    // below the demo where most visitors never scroll.
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const strip = readme.indexOf('ref=readme-top');
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(readme.indexOf('\n## '));
  });
});

describe('sponsorReleaseLine', () => {
  it('links each sponsor through the hop tagged as a release placement', () => {
    const line = sponsorReleaseLine('https://wigolo.app');
    for (const s of SPONSORS) {
      expect(line).toContain(`[${s.name}](https://wigolo.app/go/${s.slug}/?ref=release)`);
    }
  });
});

describe('sponsor logos', () => {
  // Intrinsic size from the file itself: PNG IHDR, or an SVG's width/height.
  const sizeOf = (file: string): { width: number; height: number } => {
    const buf = readFileSync(file);
    if (buf.subarray(1, 4).toString() === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    const svg = buf.toString('utf8');
    const w = svg.match(/<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/);
    const h = svg.match(/<svg[^>]*\bheight="(\d+(?:\.\d+)?)"/);
    return { width: Number(w?.[1]), height: Number(h?.[1]) };
  };

  it('ship both themes in both the README assets and the site, at the declared size', () => {
    // A missing file is a broken image on GitHub or the site; a wrong size
    // squashes the logo or shifts the page while it loads.
    for (const s of SPONSORS) {
      for (const path of [s.logo.light, s.logo.dark]) {
        const file = path.replace(/^\/sponsors\//, '');
        for (const dir of ['assets/sponsors', 'site/public/sponsors']) {
          const size = sizeOf(join(process.cwd(), dir, file));
          expect(size.width / size.height, `${dir}/${file}`).toBeCloseTo(s.logo.width / s.logo.height, 2);
        }
      }
    }
  });
});
