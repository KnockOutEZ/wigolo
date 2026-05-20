import { describe, it, expect } from 'vitest';
import { classifyContent } from '../../../../src/extraction/v1/classifier.js';

function withJsonLd(type: string | string[]): string {
  const obj = JSON.stringify({ '@context': 'https://schema.org', '@type': type, name: 'x' });
  return `<html><head><script type="application/ld+json">${obj}</script></head><body></body></html>`;
}

function withOgType(value: string): string {
  return `<html><head><meta property="og:type" content="${value}"></head><body></body></html>`;
}

describe('classifyContent — JSON-LD signals', () => {
  it('classifies Recipe schema as recipe', () => {
    expect(classifyContent('https://example.com/cookies', withJsonLd('Recipe'))).toBe('recipe');
  });

  it('classifies Product schema as product', () => {
    expect(classifyContent('https://example.com/widget', withJsonLd('Product'))).toBe('product');
  });

  it('classifies NewsArticle schema as news', () => {
    expect(classifyContent('https://example.com/story', withJsonLd('NewsArticle'))).toBe('news');
  });

  it('classifies Article schema as news', () => {
    expect(classifyContent('https://example.com/post', withJsonLd('Article'))).toBe('news');
  });

  it('classifies BlogPosting schema as news', () => {
    expect(classifyContent('https://example.com/blog/1', withJsonLd('BlogPosting'))).toBe('news');
  });

  it('classifies TechArticle schema as docs', () => {
    expect(classifyContent('https://example.com/guide', withJsonLd('TechArticle'))).toBe('docs');
  });

  it('classifies APIReference schema as docs', () => {
    expect(classifyContent('https://example.com/api', withJsonLd('APIReference'))).toBe('docs');
  });

  it('classifies QAPage schema as code', () => {
    expect(classifyContent('https://example.com/q/42', withJsonLd('QAPage'))).toBe('code');
  });

  it('classifies Question schema as code', () => {
    expect(classifyContent('https://example.com/q/42', withJsonLd('Question'))).toBe('code');
  });

  it('classifies Answer schema as code', () => {
    expect(classifyContent('https://example.com/a/42', withJsonLd('Answer'))).toBe('code');
  });

  it('handles JSON-LD @type as an array', () => {
    const html = withJsonLd(['CreativeWork', 'Recipe']);
    expect(classifyContent('https://example.com/r', html)).toBe('recipe');
  });

  it('handles JSON-LD @type with schema.org URI prefix', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'http://schema.org/Recipe',
    })}</script></head><body></body></html>`;
    expect(classifyContent('https://example.com/r', html)).toBe('recipe');
  });

  it('falls through gracefully when JSON-LD is malformed', () => {
    const html = `<html><head>
      <script type="application/ld+json">{not valid json</script>
      <meta property="og:type" content="article">
    </head><body></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('news');
  });

  it('walks @graph entries to find a useful @type', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'site' },
        { '@type': 'Recipe', name: 'cookies' },
      ],
    })}</script></head><body></body></html>`;
    expect(classifyContent('https://example.com/r', html)).toBe('recipe');
  });
});

describe('classifyContent — og:type signals', () => {
  it('classifies og:type=article as news', () => {
    expect(classifyContent('https://example.com/x', withOgType('article'))).toBe('news');
  });

  it('classifies og:type=product as product', () => {
    expect(classifyContent('https://example.com/x', withOgType('product'))).toBe('product');
  });

  it('classifies og:type=recipe as recipe', () => {
    expect(classifyContent('https://example.com/x', withOgType('recipe'))).toBe('recipe');
  });

  it('ignores irrelevant og:type values and falls through', () => {
    expect(classifyContent('https://example.com/x', withOgType('website'))).toBe('generic');
  });
});

describe('classifyContent — host signals', () => {
  const empty = '<html><head></head><body></body></html>';

  it('classifies github.com URLs as code', () => {
    expect(classifyContent('https://github.com/anthropics/claude', empty)).toBe('code');
  });

  it('classifies gist.github.com URLs as code', () => {
    expect(classifyContent('https://gist.github.com/u/abc', empty)).toBe('code');
  });

  it('classifies stackoverflow.com URLs as code', () => {
    expect(classifyContent('https://stackoverflow.com/questions/123', empty)).toBe('code');
  });

  it('classifies *.stackexchange.com URLs as code', () => {
    expect(classifyContent('https://serverfault.stackexchange.com/q/1', empty)).toBe('code');
  });

  it('classifies developer.mozilla.org URLs as docs', () => {
    expect(classifyContent('https://developer.mozilla.org/en-US/docs/Web', empty)).toBe('docs');
  });

  it('classifies devdocs.io URLs as docs', () => {
    expect(classifyContent('https://devdocs.io/javascript/', empty)).toBe('docs');
  });

  it('classifies hosts starting with docs. as docs', () => {
    expect(classifyContent('https://docs.example.com/', empty)).toBe('docs');
  });

  it('classifies /docs/ path as docs', () => {
    expect(classifyContent('https://example.com/docs/intro', empty)).toBe('docs');
  });

  it('classifies /documentation/ path as docs', () => {
    expect(classifyContent('https://example.com/documentation/intro', empty)).toBe('docs');
  });

  it('classifies /reference/ path as docs', () => {
    expect(classifyContent('https://example.com/reference/widgets', empty)).toBe('docs');
  });

  it('classifies /api/ path as docs', () => {
    expect(classifyContent('https://example.com/api/v1', empty)).toBe('docs');
  });
});

describe('classifyContent — precedence', () => {
  const recipeJsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
  })}</script>`;

  it('JSON-LD beats og:type', () => {
    const html = `<html><head>${recipeJsonLd}<meta property="og:type" content="article"></head><body></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('recipe');
  });

  it('JSON-LD beats host', () => {
    const html = `<html><head>${recipeJsonLd}</head><body></body></html>`;
    expect(classifyContent('https://github.com/foo/bar', html)).toBe('recipe');
  });

  it('og:type beats host', () => {
    expect(classifyContent('https://github.com/foo/bar', withOgType('article'))).toBe('news');
  });

  it('host beats body markers', () => {
    const html = `<html><head></head><body><div itemtype="https://schema.org/Recipe"></div></body></html>`;
    expect(classifyContent('https://github.com/foo/bar', html)).toBe('code');
  });
});

describe('classifyContent — body marker fallback', () => {
  it('classifies microdata Recipe itemtype as recipe', () => {
    const html = `<html><head></head><body><div itemscope itemtype="https://schema.org/Recipe"></div></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('recipe');
  });

  it('classifies microdata Product itemtype as product', () => {
    const html = `<html><head></head><body><div itemscope itemtype="http://schema.org/Product"></div></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('product');
  });

  it('classifies <article> + <time datetime> as news', () => {
    const html = `<html><head></head><body><article><time datetime="2024-01-01">Jan 1</time><p>Body</p></article></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('news');
  });

  it('does not classify lone <article> without <time datetime> as news', () => {
    const html = `<html><head></head><body><article><p>Body</p></article></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('generic');
  });
});

describe('classifyContent — generic fallback', () => {
  it('returns generic when no signals match', () => {
    const html = `<html><head><title>Hello</title></head><body><p>Hi</p></body></html>`;
    expect(classifyContent('https://example.com/x', html)).toBe('generic');
  });

  it('returns generic for empty HTML', () => {
    expect(classifyContent('https://example.com/x', '')).toBe('generic');
  });

  it('returns generic when URL is invalid', () => {
    expect(classifyContent('not a url', '<html></html>')).toBe('generic');
  });
});
