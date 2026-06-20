import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getExtractProvider,
  _resetExtractProviderForTest,
} from '../../src/providers/extract-provider.js';
import { V1Extractor } from '../../src/extraction/v1/extract-provider.js';

const articleFixture = readFileSync(
  join(import.meta.dirname, '../fixtures/extraction/article.html'),
  'utf-8',
);

const reactShell = readFileSync(
  join(import.meta.dirname, '../fixtures/extraction/react-reference-shell.html'),
  'utf-8',
);

// Real served HTML for https://react.dev/reference/react (captured live). Unlike
// the hand-built shell above, this carries react.dev's real layout: <main> and the
// reference-index <aside> are both wrapped in a grid container whose Tailwind class
// happens to contain the substring "sidebar" (grid-cols-sidebar-content). The
// over-broad [class*="sidebar"] boilerplate selector matched that wrapper and deleted
// the WHOLE content region, leaving only the 7-link top nav (~228-char markdown). The
// shell fixture cannot reproduce this — that blind spot hid the bug repeatedly.
const reactReferenceReal = readFileSync(
  join(import.meta.dirname, '../fixtures/extraction/react-reference-real.html'),
  'utf-8',
);

// Real served HTML for https://vuejs.org/guide/introduction (captured live, body
// trimmed). VitePress nests the page as
//   <div class="VPContent has-sidebar">
//     <aside class="VPSidebar">…</aside>
//     <div class="VPContentDoc has-aside has-sidebar"><main>…guide body…</main></div>
// Both layout wrappers carry the substring "sidebar" in a state class (has-sidebar)
// yet each CONTAINS the page's single <main>. The boilerplate pre-pass matched and
// removed the whole VPContent wrapper, deleting <main> before content-root isolation
// could find it — leaving only the VitePress navbar cluster (~nav-only markdown).
const vitepressGuide = readFileSync(
  join(import.meta.dirname, '../fixtures/extraction/vitepress-guide.html'),
  'utf-8',
);

function recipeFixture(): string {
  const recipe = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Chocolate Chip Cookies',
    description: 'Classic chewy chocolate chip cookies that everyone loves at home and at parties for sure.',
    totalTime: 'PT30M',
    recipeIngredient: [
      '2 cups flour',
      '1 cup sugar',
      '1 cup chocolate chips',
      '1 stick butter',
      '2 eggs',
    ],
    recipeInstructions: [
      { text: 'Preheat oven to 375 F.' },
      { text: 'Mix dry ingredients.' },
      { text: 'Add wet ingredients and combine.' },
      { text: 'Drop spoonfuls onto baking sheet.' },
      { text: 'Bake for 10-12 minutes.' },
    ],
  };
  return `<html><head><title>Recipe</title>
    <script type="application/ld+json">${JSON.stringify(recipe)}</script>
  </head><body><h1>Recipe page</h1></body></html>`;
}

function productFixture(): string {
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Acme Widget Pro',
    description: 'A premium widget that solves widget problems quickly. Comes with a guarantee.',
    brand: { '@type': 'Brand', name: 'Acme' },
    offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD' },
    sku: 'AW-PRO-001',
  };
  return `<html><head><title>Widget</title>
    <script type="application/ld+json">${JSON.stringify(product)}</script>
  </head><body><h1>Widget</h1></body></html>`;
}

function genericHtml(body: string): string {
  return `<html><head><title>Generic page</title></head><body>${body}</body></html>`;
}

describe('extract pipeline v1 — integration via factory', () => {
  beforeEach(() => {
    _resetExtractProviderForTest();
  });

  afterEach(() => {
    _resetExtractProviderForTest();
  });

  it('factory returns V1Extractor with name=v1', async () => {
    const provider = await getExtractProvider();
    expect(provider).toBeInstanceOf(V1Extractor);
    expect(provider.name).toBe('v1');
  });

  it('extracts a news/article fixture through the routed pipeline', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      articleFixture,
      'https://example.com/blog/scrapers',
    );

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(100);
    expect(['defuddle', 'readability', 'turndown', 'site-specific']).toContain(
      result.extractor,
    );
    // Metadata merged from html meta tags by post-processing.
    expect(result.metadata.description).toContain('TypeScript');
  });

  it('extracts a recipe fixture and emits site-specific markdown', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(recipeFixture(), 'https://example.com/cookies');

    expect(result.title).toBe('Chocolate Chip Cookies');
    expect(result.markdown).toContain('## Ingredients');
    expect(result.markdown).toContain('## Instructions');
    expect(result.extractor).toBe('site-specific');
  });

  it('extracts a product fixture and emits price and brand', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(productFixture(), 'https://example.com/widget');

    expect(result.title).toBe('Acme Widget Pro');
    expect(result.markdown).toContain('**Brand:** Acme');
    expect(result.markdown).toContain('USD 49.99');
    expect(result.extractor).toBe('site-specific');
  });

  it('falls back to defuddle/readability/turndown for a generic page', async () => {
    const provider = await getExtractProvider();
    const html = genericHtml(
      `<article><h1>Some Generic Article</h1>
       <p>${'Here is a long paragraph repeated many times to clear thresholds. '.repeat(20)}</p>
       <p>${'More body content with sufficient length and detail to satisfy extractors. '.repeat(15)}</p>
      </article>`,
    );
    const result = await provider.extract(html, 'https://example.com/random');

    expect(result.markdown.length).toBeGreaterThan(100);
    expect(['defuddle', 'readability', 'turndown', 'site-specific']).toContain(
      result.extractor,
    );
  });

  it('honors maxChars truncation through post-processing', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      articleFixture,
      'https://example.com/blog/scrapers',
      { maxChars: 200 },
    );
    expect(result.markdown.length).toBeLessThanOrEqual(200);
  });

  it('extracts links and images via post-processing', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      articleFixture,
      'https://example.com/blog/scrapers',
    );
    expect(Array.isArray(result.links)).toBe(true);
    expect(Array.isArray(result.images)).toBe(true);
  });

  it('SPA reference page → main content at small char cap, not nav-only', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(reactShell, 'https://react.dev/reference/react', {
      maxChars: 1200,
    });
    // body content present
    expect(result.markdown).toMatch(/reference|component|hook|api/i);
    // nav-only failure mode absent: the nav link cluster must not dominate the head of output
    const head = result.markdown.slice(0, 400);
    expect(head).not.toMatch(/Learn.*Reference.*Community.*Blog/s);
    expect(result.markdown.length).toBeGreaterThan(200);
  });

  it('REAL react.dev/reference/react → reference body, not 7-link nav-only', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      reactReferenceReal,
      'https://react.dev/reference/react',
    );
    // The reference body — intro prose + the Hooks/Components/APIs index — must survive.
    expect(result.markdown).toMatch(/detailed reference/i);
    expect(result.markdown).toMatch(/Hooks/);
    expect(result.markdown).toMatch(/Components/);
    // Nav-only failure mode (~228 chars of brand links) must be gone.
    expect(result.markdown.length).toBeGreaterThan(500);
    const head = result.markdown.slice(0, 300);
    expect(head).not.toMatch(/React.*v19.*Learn.*Reference.*Community.*Blog/s);
  });

  it('REAL vuejs.org/guide/introduction → VitePress guide body, not navbar-only', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      vitepressGuide,
      'https://vuejs.org/guide/introduction',
    );
    // The guide body inside <main> must survive the boilerplate pre-pass.
    expect(result.markdown).toMatch(/Single-File/);
    expect(result.markdown).toMatch(/declarative/i);
    expect(result.markdown).toMatch(/reactiv/i);
    expect(result.markdown).toMatch(/Progressive Framework/);
    expect(result.markdown.length).toBeGreaterThan(500);
    // Navbar-only failure mode must be gone: the VitePress top-nav cluster
    // ("Main Navigation … Quick Start … Tutorial … Examples … API") must not
    // lead the output.
    const head = result.markdown.slice(0, 300);
    expect(head).not.toMatch(/Main Navigation.*Quick Start.*Tutorial.*Examples.*API/s);
  });
});

const REGRESSION_FIXTURES = ['article.html', 'blog-post.html', 'news-article.html'];

describe('extraction regression — content-root must not alter clean pages', () => {
  beforeEach(() => {
    _resetExtractProviderForTest();
  });

  afterEach(() => {
    _resetExtractProviderForTest();
  });

  for (const name of REGRESSION_FIXTURES) {
    it(`${name} extraction is byte-stable`, async () => {
      const html = readFileSync(
        join(import.meta.dirname, `../fixtures/extraction/${name}`),
        'utf-8',
      );
      const provider = await getExtractProvider();
      const result = await provider.extract(html, 'https://example.com/post');
      expect({
        markdown: result.markdown,
        title: result.title ?? null,
        description: result.metadata?.description ?? null,
        author: result.metadata?.author ?? null,
        language: result.metadata?.language ?? null,
      }).toMatchSnapshot();
    });
  }
});
