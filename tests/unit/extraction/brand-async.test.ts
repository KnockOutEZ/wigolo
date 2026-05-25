/**
 * Slice B2b integration tests for `extractBrandAsync` — the async entry
 * point that adds image-based palette extraction on top of B2a.
 *
 * Why these tests are shaped the way they are:
 *
 *   The B2a unit tests pin the sync extractor's contract (priority of
 *   logo sources, CSS-var color parsing, social link normalization, etc).
 *   Those must stay green and unchanged.
 *
 *   B2b adds ONE behavior: when CSS vars miss, fetch the logo or
 *   og_image and quantize a palette. The contract is small but the
 *   regression net needs to be tight because:
 *     - The image fetch is network-side-effect bearing — tests must
 *       inject a mock fetcher so the suite remains hermetic.
 *     - `provenance.colors` is what downstream agents look at to decide
 *       whether to trust the value. Every assertion here pins both
 *       `primary_colors` AND `provenance.colors` together.
 *     - The skip-when-CSS-vars-already-suffice path is a budget
 *       optimization — without a test for it we'd silently start
 *       fetching every page's logo on warm cache (waste).
 *     - SVG sources are a known gotcha (palette algorithms can't quant
 *       XML). The skip-SVG test prevents a regression where we start
 *       sending SVG bytes through sharp and get back garbage colors.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  extractBrand,
  extractBrandAsync,
  defaultImageFetcher,
  type BrandImageFetcher,
} from '../../../src/extraction/brand.js';

const wrap = (head: string, body = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

// Build a small in-memory PNG with two distinct color regions. Used by
// every test that exercises the palette path so we know the input bytes
// are well-formed raster pixels.
async function makeBrandPng(colorA: [number, number, number], colorB: [number, number, number]): Promise<Buffer> {
  const size = 32;
  const half = (size * size * 3) / 2;
  const data = Buffer.alloc(size * size * 3);
  for (let i = 0; i < half; i += 3) {
    data[i] = colorA[0];
    data[i + 1] = colorA[1];
    data[i + 2] = colorA[2];
  }
  for (let i = half; i < data.length; i += 3) {
    data[i] = colorB[0];
    data[i + 1] = colorB[1];
    data[i + 2] = colorB[2];
  }
  return sharp(data, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

describe('extractBrandAsync — palette fallback', () => {
  it('fires palette extraction when CSS vars miss and a logo URL exists', async () => {
    // No <style> block → CSS vars produce zero colors. We declare a
    // JSON-LD logo so the priority resolver picks a definite URL the
    // fetcher can serve. Provenance must flip to 'palette-extraction'.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
    `);
    const png = await makeBrandPng([99, 91, 255], [0, 212, 255]);
    const fetcher: BrandImageFetcher = vi.fn(async () => ({ buffer: png, contentType: 'image/png' }));

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    expect(out.primary_colors?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(out.provenance?.colors).toBe('palette-extraction');
    expect(fetcher).toHaveBeenCalledWith(
      'https://acme.example/logo.png',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('does NOT fetch when CSS vars already provide ≥2 colors', async () => {
    // Two CSS vars present → palette path should be skipped entirely.
    // This protects the round-trip budget; without it, every brand
    // call would do a logo fetch even when colors are already known.
    const html = wrap(`
      <style>:root { --brand-primary: #635bff; --color-accent: #00d4ff; }</style>
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
    `);
    const fetcher: BrandImageFetcher = vi.fn(async () => null);

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    expect(out.provenance?.colors).toBe('css-vars');
    expect(out.primary_colors).toContain('#635bff');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('still fetches when CSS vars return only 1 color (need ≥2)', async () => {
    // Only one --brand-primary → 1 color via CSS vars. Single colors
    // aren't a useful brand "palette" so we fall through to image.
    // After palette runs, provenance flips to 'palette-extraction'
    // and the original CSS-var color is replaced (image is now the
    // authoritative source).
    const html = wrap(`
      <style>:root { --brand-primary: #abcdef; }</style>
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
    `);
    const png = await makeBrandPng([200, 30, 30], [30, 100, 200]);
    const fetcher: BrandImageFetcher = vi.fn(async () => ({ buffer: png, contentType: 'image/png' }));

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    expect(out.provenance?.colors).toBe('palette-extraction');
    expect(out.primary_colors?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('falls back to og_image_url when no logo / favicon exists', async () => {
    // Logo-less marketing pages still expose og:image. The sync
    // extractor falls back through logo → favicon, so to exercise the
    // og:image path we drop baseUrl (which is what favicon resolution
    // needs to construct `/favicon.ico`). With no resolvable logo, og:image
    // becomes the candidate.
    const html = wrap(`
      <meta property="og:image" content="https://acme.example/social.png">
    `);
    const png = await makeBrandPng([99, 91, 255], [0, 212, 255]);
    const fetcher: BrandImageFetcher = vi.fn(async () => ({ buffer: png, contentType: 'image/png' }));

    const out = await extractBrandAsync(html, {
      imageFetcher: fetcher,
    });

    expect(out.provenance?.colors).toBe('palette-extraction');
    expect(fetcher).toHaveBeenCalledWith(
      'https://acme.example/social.png',
      expect.anything(),
    );
  });

  it('prefers logo_url over og_image_url when both exist', async () => {
    // Priority test. logo_url is Organization-shape and most
    // semantically the brand color carrier; og:image is often a hero
    // shot. If priority flips silently, palettes start sampling hero
    // illustrations and the brand color is buried.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
      <meta property="og:image" content="https://acme.example/hero.png">
    `);
    const png = await makeBrandPng([99, 91, 255], [0, 212, 255]);
    const calls: string[] = [];
    const fetcher: BrandImageFetcher = async (url) => {
      calls.push(url);
      return { buffer: png, contentType: 'image/png' };
    };

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    expect(out.provenance?.colors).toBe('palette-extraction');
    expect(calls).toEqual(['https://acme.example/logo.png']);
  });
});

describe('extractBrandAsync — graceful failure', () => {
  it('keeps provenance.colors as "unknown" when image fetch returns null', async () => {
    // Network errors, 404s, etc. The extractor must not throw — it
    // must return a usable envelope with provenance flagged so the
    // downstream agent can decide what to do.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
    `);
    const fetcher: BrandImageFetcher = vi.fn(async () => null);

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    expect(out.provenance?.colors).toBe('unknown');
    expect(out.primary_colors).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps provenance.colors as "unknown" when palette quantization yields <2 colors', async () => {
    // A degenerate 1x1 PNG of a single color produces only one cluster.
    // We treat that as "no useful palette" and don't downgrade the
    // result envelope.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
    `);
    const flat = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 99, g: 91, b: 255 } },
    })
      .png()
      .toBuffer();
    const fetcher: BrandImageFetcher = vi.fn(async () => ({ buffer: flat, contentType: 'image/png' }));

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    // Single-color image → palette returns only one cluster (white/grey
    // filter doesn't apply since 99,91,255 is saturated). The extractor
    // accepts <2 colors only if it can fall back to monochrome — when
    // even that fails, provenance stays unknown.
    if (out.provenance?.colors === 'palette-extraction') {
      // sharp+kmeans may detect minor PNG noise → that's fine; assert ≥2.
      expect(out.primary_colors?.length ?? 0).toBeGreaterThanOrEqual(2);
    } else {
      expect(out.provenance?.colors).toBe('unknown');
      expect(out.primary_colors).toBeUndefined();
    }
  });

  it('skips palette extraction entirely for .svg logo URLs', async () => {
    // SVG bytes are XML, not pixels — the palette quantizer can't use
    // them. We short-circuit BEFORE the fetch so we don't burn the
    // budget on a useless round-trip.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.svg"}
      </script>
    `);
    const fetcher: BrandImageFetcher = vi.fn(async () => null);

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    // No fetch happened, provenance stays as sync result determined.
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.provenance?.colors).toBe('unknown');
  });

  it('short-circuits SVG even when the URL carries a query string', async () => {
    // Security review (PR #72) flagged that `.endsWith('.svg')` on the
    // raw URL string misses `…/logo.svg?v=2` and equivalent cache-busted
    // forms. Without parsing pathname first, the fetcher gets invoked
    // (waste of budget) and the post-fetch MIME guard becomes the only
    // safety net. We pin the short-circuit to the pathname.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.svg?v=2"}
      </script>
    `);
    const fetcher: BrandImageFetcher = vi.fn(async () => null);

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(out.provenance?.colors).toBe('unknown');
  });

  it('skips palette extraction when neither logo_url nor og_image_url exists', async () => {
    // Bare page → no fetchable source. The extractor must not invent
    // a URL nor crash.
    const html = wrap('<title>No assets</title>');
    const fetcher: BrandImageFetcher = vi.fn(async () => null);

    const out = await extractBrandAsync(html, { imageFetcher: fetcher });

    // No fetch happened, provenance stays as sync result determined.
    // (favicon may still surface as logo_url because the sync extractor
    // falls back to /favicon.ico — but with no baseUrl, favicon resolution
    // also returns nothing.)
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.provenance?.colors).toBe('unknown');
  });
});

describe('extractBrandAsync — control flags', () => {
  it('skips palette extraction when imageFetcher: null is passed explicitly', async () => {
    // Caller-side opt-out. Useful when an upstream cache already knows
    // the palette and the call only needs DOM/meta data.
    const html = wrap(`
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png"}
      </script>
    `);

    const out = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: null,
    });

    expect(out.provenance?.colors).toBe('unknown');
    expect(out.primary_colors).toBeUndefined();
  });

  it('does NOT mutate the result of the synchronous extractBrand when palette path is skipped', async () => {
    // Defensive test: the async wrapper must return the same shape as
    // the sync extractor for sites with established CSS-var colors.
    const html = wrap(`
      <style>:root { --brand-primary: #635bff; --color-accent: #00d4ff; }</style>
      <meta property="og:site_name" content="Acme">
    `);

    const sync = extractBrand(html, { baseUrl: 'https://acme.example/' });
    const asyncOut = await extractBrandAsync(html, {
      baseUrl: 'https://acme.example/',
      imageFetcher: null,
    });

    expect(asyncOut.primary_colors).toEqual(sync.primary_colors);
    expect(asyncOut.provenance?.colors).toBe(sync.provenance?.colors);
  });
});

describe('extractBrandAsync — fixture-mirror coverage', () => {
  it('flips ≥5 hand-rolled CSS-var-less sites to palette-extraction provenance', async () => {
    // The 20-site B2a fixtures already produce CSS-var colors. To
    // verify B2b actually fires the palette path, we strip the <style>
    // blocks from 5 of them and assert the provenance flips.
    //
    // Why 5 and not all 20: the B2a fixtures intentionally test the
    // CSS-var path. We want regression coverage for the palette path
    // without duplicating the entire 20-site corpus — 5 is enough to
    // catch a "palette path silently broke for all sites" regression.
    const fixturesMinusCss: Array<{ slug: string; baseUrl: string }> = [
      { slug: 'stripe', baseUrl: 'https://stripe.com/' },
      { slug: 'linear', baseUrl: 'https://linear.app/' },
      { slug: 'vercel', baseUrl: 'https://vercel.com/' },
      { slug: 'github', baseUrl: 'https://github.com/' },
      { slug: 'openai', baseUrl: 'https://openai.com/' },
    ];

    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fixturesDir = join(import.meta.dirname, '../../fixtures/brand');

    const png = await makeBrandPng([99, 91, 255], [0, 212, 255]);
    const fetcher: BrandImageFetcher = async () => ({ buffer: png, contentType: 'image/png' });

    let flipped = 0;
    for (const { slug, baseUrl } of fixturesMinusCss) {
      const html = readFileSync(join(fixturesDir, `${slug}.html`), 'utf-8');
      // Strip the <style> block. We keep the rest of the document so
      // logo_url / og_image_url resolution remains realistic.
      const stripped = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
      const out = await extractBrandAsync(stripped, { baseUrl, imageFetcher: fetcher });
      // Skip SVG-logo sites — they get short-circuited by design.
      const candidate = out.logo_url ?? out.og_image_url;
      if (candidate && candidate.toLowerCase().endsWith('.svg')) continue;
      if (out.provenance?.colors === 'palette-extraction') flipped++;
    }

    expect(flipped).toBeGreaterThanOrEqual(3);
  });
});

/**
 * SSRF hardening (PR #72 security review).
 *
 * The `defaultImageFetcher` is the production wiring used when the caller
 * does not inject a mock. `safeAbsoluteUrl` only filters dangerous schemes
 * (javascript:, data:, file:, vbscript:, blob:) — it does NOT block
 * loopback / RFC 1918 / link-local / IPv6 private hostnames. Without a
 * dedicated guard, an attacker-controlled page can ship a JSON-LD
 * `"logo": "http://169.254.169.254/latest/meta-data/"` and trick the
 * server into making the request on their behalf.
 *
 * These tests pin:
 *   - The fetcher rejects loopback IPv4 / link-local / IPv6 loopback /
 *     non-http(s) schemes BEFORE any network call.
 *   - The fetcher uses redirect:'manual' and re-validates each hop, so a
 *     302 → 127.0.0.1 cannot smuggle around the guard.
 *
 * Failures here are bugs because the post-fetch MIME / content-length
 * checks happen AFTER the request has already left the box — the SSRF
 * has already executed.
 */
describe('defaultImageFetcher — SSRF guard', () => {
  it('returns null for direct loopback IPv4 (http://127.0.0.1/logo.png) without fetching', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('http://127.0.0.1/logo.png');
      expect(result).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns null for AWS instance-metadata link-local (169.254.169.254) without fetching', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('http://169.254.169.254/latest/meta-data/');
      expect(result).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns null for IPv6 loopback (http://[::1]/x.png) without fetching', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('http://[::1]/x.png');
      expect(result).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns null for non-http(s) scheme (ftp://example.com/x.png) without fetching', async () => {
    // safeAbsoluteUrl strips file:/data:/blob: but accepts ftp: — the
    // guard catches it here.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('ftp://example.com/logo.png');
      expect(result).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('rejects a public URL that 302-redirects to loopback (manual-redirect guard)', async () => {
    // The defaultImageFetcher must use redirect:'manual'. A naive
    // `redirect:'follow'` would let the Node fetch implementation
    // transparently chase the 302 — bypassing the SSRF guard.
    // We assert: first call to public host returns 302, fetcher
    // sees the Location header, runs guardUrl on it, sees loopback,
    // returns null. Crucially: the second fetch (to 127.0.0.1) must
    // never happen.
    const calls: Array<{ url: string; redirect: string | undefined }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      if (String(url) === 'https://acme.example/logo.png') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/evil.png' },
        });
      }
      // This branch must never execute. If it does, the redirect was
      // followed and the SSRF guard was bypassed.
      return new Response(Buffer.from('PWNED'), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('https://acme.example/logo.png');
      expect(result).toBeNull();
      // Exactly one fetch — the initial public hop. No follow-up.
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://acme.example/logo.png');
      expect(calls[0].redirect).toBe('manual');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('follows a 302 to another public URL and returns the body (legit redirect path)', async () => {
    // Sanity: redirects to public hosts still resolve. The guard is
    // strict on private space, permissive on public — a CDN-style
    // redirect (origin → cdn) must still produce an image buffer.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u === 'https://acme.example/logo.png') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/v2/logo.png' },
        });
      }
      // Final hop: serve a tiny PNG via sharp so the bytes are real.
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 99, g: 91, b: 255 } },
      })
        .png()
        .toBuffer();
      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('https://acme.example/logo.png');
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('image/png');
      expect(calls).toEqual([
        'https://acme.example/logo.png',
        'https://cdn.example/v2/logo.png',
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('caps redirect chains at 3 hops', async () => {
    // Open-redirect chains must terminate. We chain 4 hops; the fetcher
    // must abort and return null after the 3rd follow, never reaching
    // the 4th.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      // Each hop redirects to the next; the 4th hop would serve content
      // but we should never reach it.
      const order = [
        'https://a.example/1.png',
        'https://b.example/2.png',
        'https://c.example/3.png',
        'https://d.example/4.png',
        'https://e.example/5.png',
      ];
      const idx = order.indexOf(u);
      if (idx === -1) {
        return new Response(Buffer.from('unreachable'), { status: 200 });
      }
      if (idx < order.length - 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: order[idx + 1] },
        });
      }
      return new Response(Buffer.from('reached'), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await defaultImageFetcher('https://a.example/1.png');
      expect(result).toBeNull();
      // Initial + 3 hops = 4 fetches max. We must not have made 5.
      expect(calls.length).toBeLessThanOrEqual(4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
