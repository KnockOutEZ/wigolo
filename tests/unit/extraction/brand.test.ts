/**
 * Unit tests for `src/extraction/brand.ts`.
 *
 * Why this matters:
 *  - `mode: 'brand'` is a contract surface; downstream tools (autonomous
 *    agents, dashboards, scorers) will assert on `provenance` to decide
 *    whether to trust a value. A test that just asserts "logo_url exists"
 *    can't catch a regression where we silently start returning a hero
 *    image instead of the brand mark — so every test below verifies BOTH
 *    the value AND its provenance, which is the actual contract.
 *  - The priority order (JSON-LD > og:logo > heuristic > favicon) is the
 *    only way callers can reason about quality. The priority tests below
 *    are the regression net for that ordering.
 *  - `primary_colors` is populated later via palette extraction. The
 *    CSS-vars test pins the expected provenance to `'css-vars'` so when
 *    palette extraction lands, a missed branch immediately changes the provenance and
 *    fails this suite — preventing palette extraction from masking a CSS
 *    var miss.
 */
import { describe, it, expect } from 'vitest';
import { extractBrand, __internal } from '../../../src/extraction/brand.js';

const wrap = (head: string, body = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('extractBrand — JSON-LD Organization source', () => {
  it('extracts name/description/logo from a top-level Organization block', () => {
    const html = wrap(`
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "Acme",
        "description": "We make widgets.",
        "logo": "https://acme.example/logo.svg",
        "sameAs": ["https://twitter.com/acme"]
      }
      </script>
    `);
    const out = extractBrand(html, { baseUrl: 'https://acme.example/' });
    expect(out.name).toBe('Acme');
    expect(out.description).toBe('We make widgets.');
    expect(out.logo_url).toBe('https://acme.example/logo.svg');
    expect(out.provenance?.logo).toBe('json-ld');
    expect(out.social_links?.twitter).toBe('https://twitter.com/acme');
  });

  it('reaches Organization nested inside @graph', () => {
    // Real-world JSON-LD is rarely a flat Organization — it's almost
    // always wrapped in @graph. If the recursive walker breaks, the
    // strongest source silently disappears.
    const html = wrap(`
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", "name": "Home" },
          {
            "@type": "Organization",
            "name": "Deep Brand",
            "logo": { "@type": "ImageObject", "url": "https://x.example/l.png" }
          }
        ]
      }
      </script>
    `);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.name).toBe('Deep Brand');
    expect(out.logo_url).toBe('https://x.example/l.png');
    expect(out.provenance?.logo).toBe('json-ld');
  });

  it('normalizes logo when JSON-LD ships an ImageObject instead of a string', () => {
    const html = wrap(`
      <script type="application/ld+json">
      {
        "@type": "Brand",
        "name": "B",
        "logo": { "@type": "ImageObject", "contentUrl": "https://b.example/c.png" }
      }
      </script>
    `);
    const out = extractBrand(html, { baseUrl: 'https://b.example/' });
    expect(out.logo_url).toBe('https://b.example/c.png');
  });
});

describe('extractBrand — Open Graph + Twitter Card source', () => {
  it('uses og:site_name as name and twitter:site as social handle when JSON-LD is absent', () => {
    const html = wrap(`
      <meta property="og:site_name" content="OGOnly">
      <meta property="og:description" content="OG-supplied description.">
      <meta property="og:image" content="https://ogonly.example/hero.png">
      <meta name="twitter:site" content="@ogonly">
    `);
    const out = extractBrand(html, { baseUrl: 'https://ogonly.example/' });
    expect(out.name).toBe('OGOnly');
    expect(out.description).toBe('OG-supplied description.');
    expect(out.og_image_url).toBe('https://ogonly.example/hero.png');
    // twitter:site must canonicalize to a full URL — bare `@handle` is a
    // useless leak of the implementation detail.
    expect(out.social_links?.twitter).toBe('https://twitter.com/ogonly');
  });

  it('promotes og:logo to logo_url when JSON-LD missing', () => {
    const html = wrap(`
      <meta property="og:site_name" content="WithOgLogo">
      <meta property="og:logo" content="https://wol.example/brand.svg">
    `);
    const out = extractBrand(html, { baseUrl: 'https://wol.example/' });
    expect(out.logo_url).toBe('https://wol.example/brand.svg');
    expect(out.provenance?.logo).toBe('og:logo');
  });

  it('falls back to twitter:image and og:image:secure_url for og_image_url', () => {
    const html = wrap(`
      <meta property="og:image:secure_url" content="https://secure.example/img.png">
      <meta name="twitter:image" content="https://tw.example/img.png">
    `);
    const out = extractBrand(html, { baseUrl: 'https://example.com/' });
    // og:image:secure_url is preferred over twitter:image — same priority
    // wigolo's existing metadata extractor uses, so the two stay aligned.
    expect(out.og_image_url).toBe('https://secure.example/img.png');
  });
});

describe('extractBrand — favicon / apple-touch-icon source', () => {
  it('selects SVG icon over PNG when both are declared', () => {
    // SVG is resolution-independent and effectively always the higher-
    // quality choice for downstream rendering. If a future refactor
    // accidentally returns the PNG first, brand cards in agent UIs would
    // become pixelated — this is the regression we're guarding.
    const html = wrap(`
      <link rel="icon" type="image/png" href="/favicon-32.png">
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <link rel="apple-touch-icon" href="/apple-touch.png">
    `);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.favicon_url).toBe('https://x.example/favicon.svg');
  });

  it('falls back to /favicon.ico when nothing is declared but a base URL exists', () => {
    const html = wrap('<title>No icons</title>');
    const out = extractBrand(html, { baseUrl: 'https://noicons.example/path/page' });
    expect(out.favicon_url).toBe('https://noicons.example/favicon.ico');
  });

  it('emits no favicon when no base URL is available and no <link> exists', () => {
    const html = wrap('<title>HTML only</title>');
    const out = extractBrand(html);
    expect(out.favicon_url).toBeUndefined();
  });

  it('uses apple-touch-icon as favicon when no other icon is declared', () => {
    const html = wrap('<link rel="apple-touch-icon" href="/at.png">');
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.favicon_url).toBe('https://x.example/at.png');
  });
});

describe('extractBrand — heuristic DOM logo', () => {
  it('finds the header logo via the canonical `header a[href="/"] img` pattern', () => {
    // This is the most common marketing site pattern. Failing this means
    // we miss the logo on essentially every Stripe-style template.
    const html = `<!doctype html><html><head><title>X</title></head><body>
      <header>
        <a href="/" class="Logo"><img src="/img/logo.svg" alt="Acme"></a>
      </header>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://acme.example/' });
    expect(out.logo_url).toBe('https://acme.example/img/logo.svg');
    expect(out.provenance?.logo).toBe('heuristic');
  });

  it('prefers JSON-LD logo over heuristic header logo when both exist', () => {
    // Priority test. JSON-LD wins because it's an explicit declaration —
    // a marketing team that puts a `name` + `logo` in schema.org is
    // saying "this is the brand asset".
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">{"@type":"Organization","name":"A","logo":"https://a.example/from-jsonld.svg"}</script>
    </head><body>
      <header><a href="/"><img src="/img/from-dom.svg" alt="A"></a></header>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://a.example/' });
    expect(out.logo_url).toBe('https://a.example/from-jsonld.svg');
    expect(out.provenance?.logo).toBe('json-ld');
  });

  it('does NOT promote favicon to logo_url when no real logo source exists', () => {
    // Favicons never promote to `logo_url`. A favicon is a
    // 16x16/32x32 browser tab icon — surfacing it as a logo gives callers
    // pixelated brand cards. The favicon stays in its own field; logo_url
    // is undefined and provenance is 'unknown'.
    const html = wrap(`
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <title>FaviconOnly</title>
    `);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.logo_url).toBeUndefined();
    expect(out.favicon_url).toBe('https://x.example/favicon.svg');
    expect(out.provenance?.logo).toBe('unknown');
  });
});

describe('extractBrand — social links', () => {
  it('canonicalizes a footer Twitter link to https://twitter.com/{handle}', () => {
    const html = `<!doctype html><html><head></head><body>
      <footer><a href="https://twitter.com/myhandle?utm=foo">Twitter</a></footer>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.social_links?.twitter).toBe('https://twitter.com/myhandle');
  });

  it('treats x.com as twitter', () => {
    // X.com is twitter.com under the hood; agents that look up the
    // twitter handle must not see two different surface forms.
    const html = `<!doctype html><html><head></head><body>
      <footer><a href="https://x.com/somebrand">X</a></footer>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.social_links?.twitter).toBe('https://twitter.com/somebrand');
  });

  it('extracts company-style and personal LinkedIn URLs', () => {
    const html = `<!doctype html><html><head></head><body>
      <a href="https://www.linkedin.com/company/acme-inc">LinkedIn</a>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.social_links?.linkedin).toContain('linkedin.com/company/acme-inc');
  });

  it('uses JSON-LD sameAs as a social link source', () => {
    const html = wrap(`
      <script type="application/ld+json">
      {
        "@type":"Organization",
        "name":"A",
        "sameAs":["https://twitter.com/fromld","https://github.com/fromld"]
      }
      </script>
    `);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.social_links?.twitter).toBe('https://twitter.com/fromld');
    expect(out.social_links?.github).toBe('https://github.com/fromld');
  });

  it('derives a Twitter URL from twitter:site meta when no anchor exists', () => {
    const html = wrap('<meta name="twitter:site" content="@onlymeta">');
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.social_links?.twitter).toBe('https://twitter.com/onlymeta');
  });

  it('first-wins between anchors and twitter:site (anchor links beat the meta-derived fallback)', () => {
    // Anchor links are richer signal (often link to a community/team
    // account) than the meta tag (often a corporate handle). When both
    // exist, the anchor should win — and we should NOT silently drop
    // the meta version.
    const html = `<!doctype html><html><head>
      <meta name="twitter:site" content="@frommeta">
    </head><body>
      <footer><a href="https://twitter.com/fromanchor">Twitter</a></footer>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.social_links?.twitter).toBe('https://twitter.com/fromanchor');
  });
});

describe('extractBrand — CSS-var color extraction', () => {
  it('extracts the value of --brand-primary as a normalized hex', () => {
    const html = wrap(`<style>:root { --brand-primary: #635BFF; }</style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.primary_colors).toContain('#635bff');
    expect(out.provenance?.colors).toBe('css-vars');
  });

  it('resolves rgb() and hsl() literals to hex', () => {
    const html = wrap(`<style>
      :root {
        --color-primary: rgb(99, 91, 255);
        --color-accent: hsl(248, 100%, 68%);
      }
    </style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    // rgb(99, 91, 255) is exactly Stripe purple, so its hex form is
    // load-bearing for the priority test.
    expect(out.primary_colors).toContain('#635bff');
    expect(out.provenance?.colors).toBe('css-vars');
  });

  it('extracts shadcn-style "240 5.9% 10%" triple values as hex', () => {
    // Tailwind/shadcn split HSL across whitespace rather than the
    // hsl() wrapper. Missing this idiom would zero out CSS-var colors
    // on the entire shadcn-using ecosystem.
    const html = wrap(`<style>:root { --primary: 240 5.9% 10%; }</style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.primary_colors?.length).toBeGreaterThan(0);
    expect(out.provenance?.colors).toBe('css-vars');
  });

  it('does NOT pull colors from unrelated CSS vars', () => {
    // Background and foreground must not be classified as brand
    // colors. Otherwise every site looks "the same" because we'd hand
    // back #ffffff / #000000 for almost everyone.
    const html = wrap(`<style>
      :root {
        --background: #ffffff;
        --foreground: #000000;
        --some-random-var: #abc123;
      }
    </style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.primary_colors).toBeUndefined();
    expect(out.provenance?.colors).toBe('unknown');
  });

  it('records provenance as "unknown" when no CSS vars match (palette extraction is separate)', () => {
    // This pins the sync contract: when CSS vars miss, we DON'T look
    // at pixels here. The async palette path extends this; if a future patch eagerly
    // sets `palette-extraction` without the palette path being merged, this test
    // catches the regression.
    const html = wrap('<title>no css vars</title>');
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.primary_colors).toBeUndefined();
    expect(out.provenance?.colors).toBe('unknown');
  });
});

describe('extractBrand — font hints', () => {
  it('extracts heading and body fonts from CSS custom properties', () => {
    const html = wrap(`<style>:root {
      --font-heading: "Camphor", "Helvetica Neue", sans-serif;
      --font-body: "Sohne", system-ui, sans-serif;
    }</style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.headings).toContain('Camphor');
    expect(out.fonts?.body).toContain('Sohne');
    expect(out.provenance?.fonts).toBe('css-vars');
  });

  it('extracts fonts from <style>-block body / h1-h6 font-family rules with provenance "css-rule"', () => {
    // Sites without CSS vars (older marketing pages) still declare
    // fonts via classic font-family on h1/body. We don't want to lose
    // them — agents care about typography for brand pastiche. This
    // path is provenance "css-rule" because the rule lives inside a
    // <style> block, not on an element's inline style attribute.
    const html = wrap(`<style>
      body { font-family: "Inter", system-ui, sans-serif; }
      h1, h2 { font-family: "Inter Display", Inter, sans-serif; }
    </style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body).toContain('Inter');
    expect(out.fonts?.headings).toContain('Inter Display');
    expect(out.provenance?.fonts).toBe('css-rule');
  });

  it('filters out generic font names (sans-serif, system-ui, helvetica)', () => {
    // Generic stacks tell you nothing about a brand. Filtering them
    // out is what makes `fonts` actionable signal vs noise.
    const html = wrap(`<style>:root { --font-body: sans-serif, system-ui, "Helvetica Neue"; }</style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body ?? []).not.toContain('sans-serif');
    expect(out.fonts?.body ?? []).not.toContain('system-ui');
  });

  it('extracts fonts from inline style="font-family:..." on <h1>', () => {
    // Figma-style pattern. When a page sets the font directly on the
    // header element via inline style, that's the strongest signal of
    // the brand heading face.
    const html = wrap(
      '',
      '<h1 style="font-family: \'Whyte\', sans-serif;">Headline</h1>',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.headings).toContain('Whyte');
    expect(out.provenance?.fonts).toBe('inline-style');
  });

  it('extracts fonts from inline style on <body>', () => {
    // Older marketing templates still set font-family at the body
    // element via style attribute. We treat this as the body font.
    const html =
      '<!doctype html><html><head></head>' +
      '<body style="font-family: \'Söhne\', sans-serif;">x</body></html>';
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body).toContain('Söhne');
    expect(out.provenance?.fonts).toBe('inline-style');
  });

  it('extracts the brand font from a Google Fonts <link>', () => {
    // Many sites use a single Google Fonts <link> as their primary
    // type declaration. Picking the family= query param gives us a
    // reliable brand font even when no other path fires.
    const html = wrap(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    // Single-family case: both headings and body share the family —
    // that's the common case and matches how sites use Google Fonts.
    expect(out.fonts?.body).toContain('Inter');
    expect(out.fonts?.headings).toContain('Inter');
    expect(out.provenance?.fonts).toBe('google-fonts-link');
  });

  it('extracts multiple families from a Google Fonts <link> with family=A&family=B', () => {
    const html = wrap(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter:wght@400;500&display=swap">',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    // Convention: the FIRST family is treated as the display/heading
    // face, the second is the body face. This matches how most sites
    // arrange the link tag.
    expect(out.fonts?.headings).toContain('Playfair Display');
    expect(out.fonts?.body).toContain('Inter');
    expect(out.provenance?.fonts).toBe('google-fonts-link');
  });

  it('handles the legacy Google Fonts css endpoint (family=Inter:400,700)', () => {
    const html = wrap(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter:400,700">',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body).toContain('Inter');
    expect(out.provenance?.fonts).toBe('google-fonts-link');
  });

  it('prefers CSS vars over CSS-rule over inline-style over Google Fonts when multiple sources exist', () => {
    // Priority test. The strongest signal is an explicit CSS custom
    // property; we must not silently downgrade it when a Google
    // Fonts link also exists on the page.
    const html = wrap(
      `<style>:root { --font-body: "Sohne", sans-serif; }
        body { font-family: "Should Lose", sans-serif; }</style>
       <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Should+Also+Lose&display=swap">`,
      '<body style="font-family: \'Should Lose Too\', sans-serif;"></body>',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body).toContain('Sohne');
    expect(out.fonts?.body).not.toContain('Should Lose');
    expect(out.fonts?.body).not.toContain('Should Also Lose');
    expect(out.fonts?.body).not.toContain('Should Lose Too');
    expect(out.provenance?.fonts).toBe('css-vars');
  });

  it('CSS-rule wins over inline-style attribute when CSS vars miss', () => {
    const html = wrap(
      `<style>body { font-family: "Inter", sans-serif; }</style>`,
      '<body style="font-family: \'Wrong\', sans-serif;"></body>',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body).toContain('Inter');
    expect(out.fonts?.body).not.toContain('Wrong');
    expect(out.provenance?.fonts).toBe('css-rule');
  });

  it('inline-style wins over Google Fonts <link> when CSS-rule misses', () => {
    const html = wrap(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Should+Lose&display=swap">',
      '<h1 style="font-family: \'Whyte\', sans-serif;">x</h1>',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.headings).toContain('Whyte');
    expect(out.fonts?.headings).not.toContain('Should Lose');
    expect(out.provenance?.fonts).toBe('inline-style');
  });

  it('returns fonts undefined and provenance "unknown" when no source fires', () => {
    const html = wrap('<title>no fonts</title>');
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts).toBeUndefined();
    expect(out.provenance?.fonts).toBe('unknown');
  });

  it('does not emit fonts when the only family found is a generic family', () => {
    // A `body { font-family: sans-serif; }` rule is honest about
    // having no brand font — emitting `body: []` would be misleading.
    const html = wrap(`<style>body { font-family: sans-serif; }</style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts).toBeUndefined();
    expect(out.provenance?.fonts).toBe('unknown');
  });

  it('strips generic families from CSS-rule output (sans-serif from "Inter, sans-serif")', () => {
    const html = wrap(`<style>body { font-family: "Inter", sans-serif, system-ui; }</style>`);
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts?.body).toContain('Inter');
    expect(out.fonts?.body ?? []).not.toContain('sans-serif');
    expect(out.fonts?.body ?? []).not.toContain('system-ui');
  });

  it('ignores non-Google-Fonts <link> tags', () => {
    // A stylesheet link to some other CDN must not be misread as a
    // font declaration just because we see `family=` in the URL.
    const html = wrap(
      '<link rel="stylesheet" href="https://cdn.example/app.css?family=NotAFont">',
    );
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.fonts).toBeUndefined();
    expect(out.provenance?.fonts).toBe('unknown');
  });
});

describe('extractBrand — URL safety', () => {
  it('drops javascript: / mailto: / data: schemes from logo_url and favicon_url', () => {
    // A malformed page must never produce a logo_url that, when followed,
    // would execute JavaScript. This is a safety contract. Since the
    // favicon→logo fallback was dropped, logo_url may be undefined here
    // (the only "logo" candidate is a javascript: URL that gets rejected,
    // and we no longer fall back to favicon). Honest undefined is fine;
    // a javascript: URL would NOT be.
    const html = `<!doctype html><html><head>
      <link rel="icon" href="javascript:alert(1)">
    </head><body>
      <header><a href="/"><img src="javascript:alert(2)" alt="X"></a></header>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.logo_url ?? '').not.toMatch(/^javascript:/);
    expect(out.favicon_url ?? '').not.toMatch(/^javascript:/);
    expect(out.logo_url ?? '').not.toMatch(/^mailto:/);
  });

  it('drops file: scheme from logo_url, favicon_url, og_image_url', () => {
    // A downstream auto-fetcher must never be tricked into reading local
    // files via a brand URL like `file:///etc/passwd`.
    const html = `<!doctype html><html><head>
      <link rel="icon" href="file:///etc/hosts">
      <meta property="og:image" content="file:///etc/passwd">
    </head><body>
      <header><a href="/"><img src="file:///etc/shadow" alt="X"></a></header>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.logo_url ?? '').not.toMatch(/^file:/i);
    expect(out.favicon_url ?? '').not.toMatch(/^file:/i);
    expect(out.og_image_url ?? '').not.toMatch(/^file:/i);
  });

  it('drops vbscript: scheme from logo_url, favicon_url, og_image_url', () => {
    // Legacy IE-style script schemes must be rejected with the same rigor
    // as javascript: — a downstream renderer could still execute them.
    const html = `<!doctype html><html><head>
      <link rel="icon" href="vbscript:msgbox(1)">
      <meta property="og:image" content="VBScript:msgbox(2)">
    </head><body>
      <header><a href="/"><img src="vbscript:msgbox(3)" alt="X"></a></header>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.logo_url ?? '').not.toMatch(/^vbscript:/i);
    expect(out.favicon_url ?? '').not.toMatch(/^vbscript:/i);
    expect(out.og_image_url ?? '').not.toMatch(/^vbscript:/i);
  });

  it('drops blob: scheme from logo_url, favicon_url, og_image_url', () => {
    // blob: URLs are session-scoped and never resolve to a stable fetchable
    // asset for an external agent — reject them up front.
    const html = `<!doctype html><html><head>
      <link rel="icon" href="blob:https://x.example/abc-123">
      <meta property="og:image" content="blob:https://x.example/def-456">
    </head><body>
      <header><a href="/"><img src="blob:https://x.example/ghi-789" alt="X"></a></header>
    </body></html>`;
    const out = extractBrand(html, { baseUrl: 'https://x.example/' });
    expect(out.logo_url ?? '').not.toMatch(/^blob:/i);
    expect(out.favicon_url ?? '').not.toMatch(/^blob:/i);
    expect(out.og_image_url ?? '').not.toMatch(/^blob:/i);
  });

  it('resolves relative URLs against baseUrl', () => {
    const html = wrap(`
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <script type="application/ld+json">{"@type":"Organization","name":"R","logo":"./logo.svg"}</script>
    `);
    const out = extractBrand(html, { baseUrl: 'https://r.example/sub/page' });
    expect(out.favicon_url).toBe('https://r.example/icon.svg');
    expect(out.logo_url).toBe('https://r.example/sub/logo.svg');
  });
});

describe('extractBrand — provenance contract', () => {
  it('always emits a `provenance` block with logo/colors/fonts keys', () => {
    // Even on a barebones page, `provenance` is required so callers can
    // distinguish "no data" from "we forgot to fill the field".
    const html = wrap('<title>empty</title>');
    const out = extractBrand(html);
    expect(out.provenance).toBeDefined();
    expect(out.provenance?.logo).toBe('unknown');
    expect(out.provenance?.colors).toBe('unknown');
    expect(out.provenance?.fonts).toBe('unknown');
  });
});

describe('extractBrand — internal helpers', () => {
  // These are exposed via __internal so we can pin algorithm behavior
  // without coupling the public surface to implementation choices.
  it('normalizes 3-digit hex to 6-digit lowercase', () => {
    expect(__internal.normalizeHex('#FFF')).toBe('#ffffff');
    expect(__internal.normalizeHex('#abc')).toBe('#aabbcc');
  });

  it('converts rgb() to hex', () => {
    expect(__internal.rgbToHex('rgb(99, 91, 255)')).toBe('#635bff');
  });

  it('categorizes a github.com URL as github', () => {
    const cat = __internal.categorizeSocial('https://github.com/acme');
    expect(cat?.key).toBe('github');
    expect(cat?.canonical).toBe('https://github.com/acme');
  });

  it('categorizes x.com URL as twitter (handle-preserving)', () => {
    const cat = __internal.categorizeSocial('https://x.com/acme');
    expect(cat?.key).toBe('twitter');
    expect(cat?.canonical).toBe('https://twitter.com/acme');
  });
});
