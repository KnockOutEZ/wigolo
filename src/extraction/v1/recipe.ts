import { extractJsonLd } from '../jsonld.js';
import type { ExtractionResult } from '../../types.js';

const MIN_CONTENT_THRESHOLD = 100;

export async function extractRecipe(html: string, _url: string): Promise<ExtractionResult | null> {
  if (!html) return null;

  let blocks: Record<string, unknown>[];
  try {
    blocks = extractJsonLd(html);
  } catch {
    return null;
  }

  const recipe = blocks.find((block) => typeIncludes(block['@type'], 'recipe'));
  if (!recipe) return null;

  const name = stringField(recipe['name']);
  if (!name) return null;

  const lines: string[] = [`# ${name}`];

  const description = stringField(recipe['description']);
  if (description) {
    lines.push('', description);
  }

  const metaLines: string[] = [];
  const totalTime = stringField(recipe['totalTime']);
  if (totalTime) metaLines.push(`**Total time:** ${totalTime}`);
  const prepTime = stringField(recipe['prepTime']);
  if (prepTime) metaLines.push(`**Prep time:** ${prepTime}`);
  const cookTime = stringField(recipe['cookTime']);
  if (cookTime) metaLines.push(`**Cook time:** ${cookTime}`);
  const recipeYield = stringField(recipe['recipeYield']);
  if (recipeYield) metaLines.push(`**Yield:** ${recipeYield}`);
  const cuisine = stringField(recipe['recipeCuisine']);
  if (cuisine) metaLines.push(`**Cuisine:** ${cuisine}`);
  if (metaLines.length > 0) {
    lines.push('', ...metaLines);
  }

  const ingredients = stringArray(recipe['recipeIngredient']);
  if (ingredients.length > 0) {
    lines.push('', '## Ingredients');
    for (const ingredient of ingredients) {
      lines.push(`- ${ingredient}`);
    }
  }

  const instructions = readInstructions(recipe['recipeInstructions']);
  if (instructions.length > 0) {
    lines.push('', '## Instructions');
    instructions.forEach((step, idx) => {
      lines.push(`${idx + 1}. ${step}`);
    });
  }

  const markdown = lines.join('\n').trim();
  if (markdown.length < MIN_CONTENT_THRESHOLD) return null;

  const author = readAuthor(recipe['author']);
  const datePublished = stringField(recipe['datePublished']);

  return {
    title: name,
    markdown,
    metadata: {
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      ...(datePublished ? { date: datePublished } : {}),
    },
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

function typeIncludes(raw: unknown, want: string): boolean {
  const target = want.toLowerCase();
  if (typeof raw === 'string') return normalizeType(raw) === target;
  if (Array.isArray(raw)) {
    return raw.some((entry) => typeof entry === 'string' && normalizeType(entry) === target);
  }
  return false;
}

function normalizeType(raw: string): string {
  const tail = raw.split(/[/#:]/).pop() ?? raw;
  return tail.toLowerCase();
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function readInstructions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const text = (entry as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out;
}

function readAuthor(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = readAuthor(entry);
      if (name) return name;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>)['name'];
    if (typeof name === 'string') return stringField(name);
  }
  return undefined;
}
