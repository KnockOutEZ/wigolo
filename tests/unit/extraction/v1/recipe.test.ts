import { describe, it, expect } from 'vitest';
import { extractRecipe } from '../../../../src/extraction/v1/recipe.js';

function htmlWithJsonLd(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `<!doctype html><html><head><script type="application/ld+json">${json}</script></head><body></body></html>`;
}

const FULL_RECIPE = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Chocolate Chip Cookies',
  description: 'Classic chewy chocolate chip cookies that everyone loves.',
  recipeIngredient: [
    '2 cups flour',
    '1 cup butter',
    '1 cup chocolate chips',
    '1 cup brown sugar',
    '2 eggs',
  ],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Preheat oven to 350F.' },
    { '@type': 'HowToStep', text: 'Cream butter and sugar.' },
    { '@type': 'HowToStep', text: 'Mix in eggs.' },
    { '@type': 'HowToStep', text: 'Add flour and chips, bake 12 minutes.' },
  ],
  totalTime: 'PT30M',
  prepTime: 'PT15M',
  cookTime: 'PT15M',
  recipeYield: '24 cookies',
  recipeCuisine: 'American',
  author: { '@type': 'Person', name: 'Jane Baker' },
  datePublished: '2023-01-01',
};

describe('extractRecipe — happy path', () => {
  it('builds markdown from a full Recipe JSON-LD block', async () => {
    const html = htmlWithJsonLd(FULL_RECIPE);
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Chocolate Chip Cookies');
    expect(result!.extractor).toBe('site-specific');
    expect(result!.markdown).toContain('# Chocolate Chip Cookies');
    expect(result!.markdown).toContain('Classic chewy');
    expect(result!.markdown).toContain('## Ingredients');
    expect(result!.markdown).toContain('- 2 cups flour');
    expect(result!.markdown).toContain('## Instructions');
    expect(result!.markdown).toContain('1. Preheat oven to 350F.');
    expect(result!.markdown).toContain('4. Add flour and chips, bake 12 minutes.');
    expect(result!.markdown).toContain('**Total time:** PT30M');
    expect(result!.markdown).toContain('**Yield:** 24 cookies');
    expect(result!.metadata.author).toBe('Jane Baker');
    expect(result!.metadata.date).toBe('2023-01-01');
    expect(result!.links).toEqual([]);
    expect(result!.images).toEqual([]);
  });

  it('handles instructions as array of plain strings', async () => {
    const html = htmlWithJsonLd({
      ...FULL_RECIPE,
      recipeInstructions: ['Step one.', 'Step two.', 'Step three.'],
    });
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('1. Step one.');
    expect(result!.markdown).toContain('3. Step three.');
  });

  it('handles author as a plain string', async () => {
    const html = htmlWithJsonLd({ ...FULL_RECIPE, author: 'Plain Author' });
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
    expect(result!.metadata.author).toBe('Plain Author');
  });

  it('handles @type as schema.org URI', async () => {
    const html = htmlWithJsonLd({ ...FULL_RECIPE, '@type': 'http://schema.org/Recipe' });
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
  });

  it('handles @type as array containing Recipe', async () => {
    const html = htmlWithJsonLd({ ...FULL_RECIPE, '@type': ['CreativeWork', 'Recipe'] });
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
  });
});

describe('extractRecipe — missing optional fields', () => {
  it('omits absent timing fields gracefully', async () => {
    const { totalTime, prepTime, cookTime, ...partial } = FULL_RECIPE;
    void totalTime;
    void prepTime;
    void cookTime;
    const html = htmlWithJsonLd(partial);
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
    expect(result!.markdown).not.toContain('**Total time:**');
    expect(result!.markdown).not.toContain('**Prep time:**');
    expect(result!.markdown).not.toContain('**Cook time:**');
  });

  it('omits description when not provided', async () => {
    const { description, ...partial } = FULL_RECIPE;
    void description;
    const html = htmlWithJsonLd(partial);
    const result = await extractRecipe(html, 'https://example.com/r');
    expect(result).not.toBeNull();
    expect(result!.markdown).not.toContain('Classic chewy');
  });
});

describe('extractRecipe — negative cases', () => {
  it('returns null when JSON-LD type is not Recipe', async () => {
    const html = htmlWithJsonLd({ '@type': 'Product', name: 'Widget' });
    expect(await extractRecipe(html, 'https://example.com/x')).toBeNull();
  });

  it('returns null when there is no JSON-LD at all', async () => {
    const html = '<html><head></head><body><p>nothing</p></body></html>';
    expect(await extractRecipe(html, 'https://example.com/x')).toBeNull();
  });

  it('does not throw on malformed JSON-LD blocks', async () => {
    const html = `<html><head>
      <script type="application/ld+json">{not valid</script>
    </head><body></body></html>`;
    expect(await extractRecipe(html, 'https://example.com/x')).toBeNull();
  });

  it('returns null when generated markdown is below threshold', async () => {
    const html = htmlWithJsonLd({ '@type': 'Recipe', name: 'X' });
    const result = await extractRecipe(html, 'https://example.com/x');
    expect(result).toBeNull();
  });
});
