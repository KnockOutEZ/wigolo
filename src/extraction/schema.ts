import { parseHTML } from 'linkedom';
import { extractJsonLd, matchJsonLdToSchema } from './jsonld.js';
import { createLogger } from '../logger.js';

const log = createLogger('schema');

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

export function extractWithSchema(
  html: string,
  schema: JsonSchema,
): Record<string, unknown> {
  if (!html || !schema.properties) return {};

  const jsonLdBlocks = extractJsonLd(html);
  const jsonLdResult = matchJsonLdToSchema(jsonLdBlocks, schema);

  const { document: doc } = parseHTML(html);
  const heuristicResult: Record<string, unknown> = {};

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    if (jsonLdResult[fieldName] !== undefined) continue;

    const value = findFieldValue(doc, fieldName, fieldSchema);
    if (value !== undefined) {
      heuristicResult[fieldName] = value;
    }
  }

  return { ...jsonLdResult, ...heuristicResult };
}

function findFieldValue(
  doc: Document,
  fieldName: string,
  schema: JsonSchema,
): unknown {
  const normalizedName = fieldName.toLowerCase().replace(/_/g, '-');
  const compactName = fieldName.replace(/_/g, '').toLowerCase();
  const variants = [fieldName, normalizedName, compactName];

  if (schema.type === 'array') {
    return findArrayValues(doc, variants);
  }

  return findSingleValue(doc, variants);
}

function cssEscape(value: string): string {
  return value.replace(/([^\w-])/g, '\\$1');
}

function findSingleValue(doc: Document, variants: string[]): string | undefined {
  for (const name of variants) {
    // Strategy 1: itemprop (Schema.org microdata) — highest confidence
    const byItemprop = doc.querySelector(`[itemprop="${name}"]`);
    if (byItemprop) {
      const text = byItemprop.getAttribute('content') ?? byItemprop.textContent?.trim();
      if (text) return text;
    }

    // Strategy 2: Match by class name containing field name
    const byClass = doc.querySelector(`[class*="${name}"]`);
    if (byClass) {
      const text = byClass.textContent?.trim();
      if (text) return text;
    }

    // Strategy 3: Match by aria-label (exact match)
    const byAria = doc.querySelector(`[aria-label="${name}"]`);
    if (byAria) {
      const text = byAria.textContent?.trim();
      if (text) return text;
    }

    // Strategy 3b: aria-label case-insensitive (check all elements)
    const allWithAria = doc.querySelectorAll('[aria-label]');
    for (const el of allWithAria) {
      const label = el.getAttribute('aria-label')?.toLowerCase().replace(/\s+/g, '-') ?? '';
      if (label === name.toLowerCase()) {
        const text = el.textContent?.trim();
        if (text) return text;
      }
    }

    // Strategy 4: Match by id
    const byId = doc.querySelector(`#${cssEscape(name)}`);
    if (byId) {
      const text = byId.textContent?.trim();
      if (text) return text;
    }

    // Strategy 5: Match by data attribute
    const byData = doc.querySelector(`[data-${name}]`);
    if (byData) {
      return byData.getAttribute(`data-${name}`) ?? byData.textContent?.trim() ?? undefined;
    }
  }

  return undefined;
}

function findArrayValues(doc: Document, variants: string[]): string[] | undefined {
  for (const name of variants) {
    const container = doc.querySelector(`[class*="${name}"]`);
    if (container) {
      const items = container.querySelectorAll('li, [class*="item"]');
      if (items.length > 0) {
        return Array.from(items).map((el) => (el.textContent ?? '').trim()).filter(Boolean);
      }
    }

    const singular = name.replace(/s$/, '');
    const elements = doc.querySelectorAll(`[class*="${singular}"]`);
    if (elements.length > 1) {
      return Array.from(elements).map((el) => (el.textContent ?? '').trim()).filter(Boolean);
    }
  }

  return undefined;
}
