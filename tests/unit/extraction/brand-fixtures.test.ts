/**
 * 20-site fixture coverage test.
 *
 * Why this matters: the brand extractor only earns its keep when it works
 * across the ecosystem, not on a single hand-crafted HTML. The spec's
 * success criteria require ≥20 real-world sites to surface
 * `logo_url + favicon_url + ≥1 social link + ≥1 font hint`. This file
 * iterates the same assertion across every fixture so a regression on,
 * say, "the `--font-display` variant of font detection" lights up in
 * one CI run instead of being discovered in production by an agent.
 *
 * Fixtures live in `tests/fixtures/brand/*.html` and reflect real
 * marketing-site head/meta blocks captured at the time of authoring.
 * We intentionally use cached HTML rather than live fetches so the
 * test is deterministic and runs in the unit suite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractBrand } from '../../../src/extraction/brand.js';

const fixturesDir = join(import.meta.dirname, '../../fixtures/brand');

// Base URL is required for relative-href resolution. The site -> base-url
// map matches each fixture to the real homepage origin so the resolved
// logo/favicon URLs look like what an agent would see in production.
const SITES: Record<string, string> = {
  stripe: 'https://stripe.com/',
  linear: 'https://linear.app/',
  vercel: 'https://vercel.com/',
  anthropic: 'https://www.anthropic.com/',
  github: 'https://github.com/',
  openai: 'https://openai.com/',
  notion: 'https://www.notion.so/',
  figma: 'https://www.figma.com/',
  discord: 'https://discord.com/',
  slack: 'https://slack.com/',
  cloudflare: 'https://www.cloudflare.com/',
  supabase: 'https://supabase.com/',
  railway: 'https://railway.app/',
  netlify: 'https://www.netlify.com/',
  render: 'https://render.com/',
  fly: 'https://fly.io/',
  convex: 'https://convex.dev/',
  resend: 'https://resend.com/',
  posthog: 'https://posthog.com/',
  nextjs: 'https://nextjs.org/',
  tailwind: 'https://tailwindcss.com/',
};

function loadFixture(slug: string): string {
  return readFileSync(join(fixturesDir, `${slug}.html`), 'utf-8');
}

describe('extractBrand — 20-site fixture coverage', () => {
  it('fixture directory contains at least 20 sites', () => {
    // Spec-driven baseline. If a fixture is accidentally deleted, this
    // tells us before the per-site assertions get noisy.
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.html'));
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  for (const [slug, baseUrl] of Object.entries(SITES)) {
    describe(`site: ${slug}`, () => {
      const html = loadFixture(slug);
      const out = extractBrand(html, { baseUrl });

      it('extracts a logo_url with a real provenance (not "unknown")', () => {
        // logo_url + provenance together. Provenance==='unknown' would
        // mean we found a URL but couldn't attribute it — a code smell
        // we want to fail fast on.
        expect(out.logo_url).toBeDefined();
        expect(out.provenance?.logo).not.toBe('unknown');
      });

      it('extracts a favicon_url', () => {
        expect(out.favicon_url).toBeDefined();
      });

      it('extracts at least one social link', () => {
        const social = out.social_links ?? {};
        expect(Object.keys(social).length).toBeGreaterThan(0);
      });

      it('extracts at least one font hint (headings or body)', () => {
        const fonts = out.fonts ?? {};
        const total = (fonts.headings?.length ?? 0) + (fonts.body?.length ?? 0);
        expect(total).toBeGreaterThan(0);
      });

      it('extracts at least one CSS-var-sourced primary color', () => {
        // Each fixture intentionally carries a brand-color CSS var. If
        // this fails on a real site, the spec's "CSS-var-only color
        // path" assumption needs a follow-up fixture or a tweak to the
        // var name allowlist — and this test will surface the gap.
        expect(out.primary_colors?.length ?? 0).toBeGreaterThan(0);
        expect(out.provenance?.colors).toBe('css-vars');
      });

      it('logo and favicon URLs resolve as absolute https URLs', () => {
        // Catches regressions where baseUrl resolution silently drops.
        // Without absolute URLs the agent-side preview/download flow
        // breaks immediately.
        expect(out.logo_url).toMatch(/^https:\/\//);
        expect(out.favicon_url).toMatch(/^https?:\/\//);
      });
    });
  }

  // Aggregate coverage assertion — protects against the "test pass but
  // most sites are empty" failure mode by re-counting in a single pass.
  it('reports ≥20 sites with logo + favicon + social + font + color coverage', () => {
    const required = ['logo', 'favicon', 'social', 'font', 'color'] as const;
    const counts: Record<(typeof required)[number], number> = {
      logo: 0,
      favicon: 0,
      social: 0,
      font: 0,
      color: 0,
    };

    for (const [slug, baseUrl] of Object.entries(SITES)) {
      const html = loadFixture(slug);
      const out = extractBrand(html, { baseUrl });
      if (out.logo_url) counts.logo++;
      if (out.favicon_url) counts.favicon++;
      if (out.social_links && Object.keys(out.social_links).length > 0) counts.social++;
      const fontTotal = (out.fonts?.headings?.length ?? 0) + (out.fonts?.body?.length ?? 0);
      if (fontTotal > 0) counts.font++;
      if (out.primary_colors && out.primary_colors.length > 0) counts.color++;
    }

    for (const k of required) {
      expect(counts[k]).toBeGreaterThanOrEqual(20);
    }
  });
});
