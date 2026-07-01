/**
 * Brand extract honesty.
 *
 * Why this matters:
 *   Brand extract on Anthropic.com returned `name == tagline` and
 *   `logo_url == favicon_url` — meaning the extractor silently fell back
 *   when the real value wasn't found, blurring the contract. Downstream
 *   agents that trust `name` end up rendering a tagline; agents that
 *   trust `logo_url` end up pulling a 16×16 favicon.
 *
 * Contract:
 *   - `name` is set ONLY when an explicit source emits it (JSON-LD,
 *     og:site_name, heuristic <img alt>). The page <title> tail is NOT
 *     a name source — it's typically a tagline.
 *   - `logo_url` is set ONLY when a logo source emits it (JSON-LD logo,
 *     og:logo, heuristic DOM). The favicon NEVER promotes to logo.
 *     Favicons live in their own `favicon_url` field, period.
 *   - Provenance values must match the documented enum exactly. A value
 *     emitted by the code that isn't in the doc is a bug.
 */
import { describe, it, expect } from 'vitest';
import { extractBrand } from '../../../src/extraction/brand.js';
import {
  LOGO_PROVENANCE_VALUES,
  COLORS_PROVENANCE_VALUES,
  FONTS_PROVENANCE_VALUES,
} from '../../../src/extraction/brand-provenance.js';

const wrap = (head: string, body = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('extractBrand — name honesty (M3)', () => {
  it('does NOT fall back to <title>-tail as name (returns name undefined)', () => {
    // Page has og:title but no og:site_name and no heuristic logo alt.
    // The previous behavior split the <title> on " | " and used the first
    // chunk as name — which, on a site like Anthropic.com, gave back the
    // tagline ("Home") instead of the brand name. The contract is: if we
    // don't have an explicit name source, leave it undefined.
    const html = wrap(`
      <title>Home \\\\ Anthropic</title>
      <meta property="og:title" content="Home \\\\ Anthropic">
      <meta property="og:description" content="AI safety company.">
    `);
    const out = extractBrand(html, { baseUrl: 'https://anthropic.example/' });
    expect(out.name).toBeUndefined();
    // tagline is fine to extract from og:title when it doesn't equal the
    // (missing) name — the issue is name should not also be that value.
    expect(out.tagline).not.toBe(out.name);
  });

  it('sets name when og:site_name is explicitly present', () => {
    // Positive case: when the site declares its name explicitly via
    // og:site_name, we use it (and tagline stays distinct).
    const html = wrap(`
      <meta property="og:site_name" content="Acme">
      <meta property="og:title" content="Build faster">
      <title>Build faster | Acme</title>
    `);
    const out = extractBrand(html, { baseUrl: 'https://acme.example/' });
    expect(out.name).toBe('Acme');
    // Tagline comes from og:title (distinct from name)
    expect(out.tagline).toBe('Build faster');
  });

  it('sets name from heuristic <img alt> when og:site_name is missing', () => {
    // The DOM `<img alt="Acme">` is an explicit name source — the
    // designer chose the alt text deliberately.
    const html = `<!doctype html><html><head><title>Build faster | Acme</title></head>
      <body><header><a href="/"><img src="/logo.svg" alt="Acme Corp"></a></header></body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://acme.example/' });
    expect(out.name).toBe('Acme Corp');
  });

  it('does NOT use og:title as name (og:title is a tagline source, not a name source)', () => {
    // og:title is typically the page title, NOT the brand name. The old
    // code's "if title.includes(name)" fallback could mis-classify it.
    const html = wrap(`
      <meta property="og:title" content="The world's most powerful AI">
      <title>The world's most powerful AI</title>
    `);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.name).toBeUndefined();
  });
});

describe('extractBrand — logo honesty (M3)', () => {
  it('does NOT promote favicon to logo_url when no real logo exists', () => {
    // The single most important contract: favicons are 16×16. Returning
    // one as `logo_url` makes brand cards look like blurry pixel soup.
    // If no JSON-LD logo, no og:logo, and no heuristic DOM logo exist,
    // `logo_url` must be undefined — `favicon_url` stays its own field.
    const html = wrap(`
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <title>FaviconOnly</title>
    `);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.logo_url).toBeUndefined();
    expect(out.favicon_url).toBe('https://x.example/favicon.svg');
    expect(out.provenance?.logo).toBe('unknown');
  });

  it('keeps favicon_url even when no logo_url is set (both are independent fields)', () => {
    // Honesty cuts both ways: dropping favicon_url because we couldn't
    // find a logo would also be wrong. The two fields are independent.
    const html = wrap('<link rel="icon" href="/icon.png">');
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.favicon_url).toBe('https://x.example/icon.png');
    expect(out.logo_url).toBeUndefined();
  });

  it('sets logo_url + favicon_url to different URLs when both real sources exist', () => {
    // Positive case: the page has BOTH a JSON-LD logo and a favicon —
    // both fields are populated, and they are distinct values.
    const html = wrap(`
      <script type="application/ld+json">
        {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.svg"}
      </script>
      <link rel="icon" href="/favicon.ico">
    `);
    const out = extractBrand(html, { baseUrl: 'https://acme.example/' });
    expect(out.logo_url).toBe('https://acme.example/logo.svg');
    expect(out.favicon_url).toBe('https://acme.example/favicon.ico');
    expect(out.logo_url).not.toBe(out.favicon_url);
    expect(out.provenance?.logo).toBe('json-ld');
  });

  it('does NOT promote /favicon.ico default to logo_url either', () => {
    // The synthetic "/favicon.ico" fallback (when no <link> declared) is
    // STILL just a favicon, never a logo.
    const html = wrap('<title>No icons declared</title>');
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.favicon_url).toBe('https://x.example/favicon.ico');
    expect(out.logo_url).toBeUndefined();
  });
});

describe('extractBrand — provenance enum compliance', () => {
  // Emitted provenance values like 'palette-extraction' were not in the
  // documented enum. The doc is the source of truth. Every value the code
  // emits must appear in
  // the corresponding documented enum.
  it('only emits documented logo provenance values', () => {
    // Drive every known logo-source branch through extractBrand and
    // assert the resulting provenance string is in the documented enum.
    const cases: Array<{ html: string }> = [
      // json-ld
      {
        html: wrap(`<script type="application/ld+json">
          {"@type":"Organization","name":"A","logo":"https://a.example/l.svg"}
        </script>`),
      },
      // og:logo
      {
        html: wrap(`<meta property="og:logo" content="https://a.example/l.svg">
                   <meta property="og:site_name" content="A">`),
      },
      // heuristic
      {
        html: `<!doctype html><html><head></head><body>
          <header><a href="/"><img src="/l.svg" alt="A"></a></header>
        </body></html>`,
      },
      // link[rel=icon] (favicon — no logo found path)
      {
        html: wrap(`<link rel="icon" href="/i.svg"><title>F</title>`),
      },
      // unknown (no logo source)
      {
        html: wrap('<title>empty</title>'),
      },
    ];
    for (const c of cases) {
      const out = extractBrand(c.html, { baseUrl: 'https://a.example/' });
      const val = out.provenance?.logo;
      expect(val).toBeDefined();
      expect(LOGO_PROVENANCE_VALUES).toContain(val!);
    }
  });

  it('only emits documented colors provenance values', () => {
    const cases: Array<{ html: string }> = [
      // css-vars
      { html: wrap(`<style>:root { --brand-primary: #635bff; }</style>`) },
      // unknown
      { html: wrap('<title>nothing</title>') },
    ];
    for (const c of cases) {
      const out = extractBrand(c.html, { baseUrl: 'https://x.example/' });
      const val = out.provenance?.colors;
      expect(val).toBeDefined();
      expect(COLORS_PROVENANCE_VALUES).toContain(val!);
    }
  });

  it('only emits documented fonts provenance values', () => {
    const cases: Array<{ html: string }> = [
      // css-vars
      { html: wrap(`<style>:root { --font-heading: "Inter", sans-serif; }</style>`) },
      // css-rule
      { html: wrap(`<style>body { font-family: "Inter", sans-serif; }</style>`) },
      // inline-style
      {
        html: wrap('', '<h1 style="font-family: \'Inter\', sans-serif;">x</h1>'),
      },
      // google-fonts-link
      {
        html: wrap(
          `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`,
        ),
      },
      // unknown
      { html: wrap('<title>nothing</title>') },
    ];
    for (const c of cases) {
      const out = extractBrand(c.html, { baseUrl: 'https://x.example/' });
      const val = out.provenance?.fonts;
      expect(val).toBeDefined();
      expect(FONTS_PROVENANCE_VALUES).toContain(val!);
    }
  });

  it('the LOGO_PROVENANCE_VALUES enum lists exactly the values the type permits (L3)', () => {
    // This pins doc == code. If a future PR adds a new emission point
    // without adding the value to the enum, this test fails. If the
    // enum carries a value the code never emits, that's also a doc bug
    // we want surfaced (but harder to detect from a test — covered by
    // the per-branch tests above).
    expect(LOGO_PROVENANCE_VALUES).toEqual([
      'json-ld',
      'og:logo',
      'link[rel=icon]',
      'heuristic',
      'unknown',
    ]);
  });

  it('the COLORS_PROVENANCE_VALUES enum matches the documented set (L3)', () => {
    expect(COLORS_PROVENANCE_VALUES).toEqual([
      'css-vars',
      'palette-extraction',
      'unknown',
    ]);
  });

  it('the FONTS_PROVENANCE_VALUES enum matches the documented set (L3)', () => {
    expect(FONTS_PROVENANCE_VALUES).toEqual([
      'css-vars',
      'css-rule',
      'inline-style',
      'google-fonts-link',
      'unknown',
    ]);
  });
});
