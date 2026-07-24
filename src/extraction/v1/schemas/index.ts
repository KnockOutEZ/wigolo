import type { NamedSchemaType } from '../../../types.js';
import { extractArticle, type ArticleData } from './Article.js';
import { extractRecipeSchema, type RecipeData } from './Recipe.js';
import { extractProductSchema, type ProductData } from './Product.js';
import { extractCodeSnippet, type CodeSnippetData } from './CodeSnippet.js';
import { extractPaper, type PaperData } from './Paper.js';
import { extractEventListing, type EventListingData } from './EventListing.js';
import { extractJobPosting, type JobPostingData } from './JobPosting.js';

export type { NamedSchemaType } from '../../../types.js';

export type NamedSchemaData =
  | ArticleData
  | RecipeData
  | ProductData
  | CodeSnippetData
  | PaperData
  | EventListingData
  | JobPostingData;

export const NAMED_SCHEMAS: readonly NamedSchemaType[] = [
  'Article',
  'Recipe',
  'Product',
  'CodeSnippet',
  'Paper',
  'EventListing',
  'JobPosting',
] as const;

export function isNamedSchemaType(s: string): s is NamedSchemaType {
  return (NAMED_SCHEMAS as readonly string[]).includes(s);
}

export async function extractNamedSchema(
  schema: NamedSchemaType,
  html: string,
  url: string,
): Promise<NamedSchemaData | null> {
  switch (schema) {
    case 'Article':
      return extractArticle(html, url);
    case 'Recipe':
      return extractRecipeSchema(html, url);
    case 'Product':
      return extractProductSchema(html, url);
    case 'CodeSnippet':
      return extractCodeSnippet(html, url);
    case 'Paper':
      return extractPaper(html, url);
    case 'EventListing':
      return extractEventListing(html, url);
    case 'JobPosting':
      return extractJobPosting(html, url);
    default: {
      const _exhaustive: never = schema;
      void _exhaustive;
      return null;
    }
  }
}
