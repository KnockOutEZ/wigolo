import { parseHTML } from 'linkedom';
import { createLogger } from '../logger.js';

const log = createLogger('jsonld');

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

export function extractJsonLd(html: string): Record<string, unknown>[] {
  const { document: doc } = parseHTML(html);
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const results: Record<string, unknown>[] = [];

  for (const script of Array.from(scripts)) {
    try {
      const text = script.textContent?.trim();
      if (!text) continue;

      const parsed = JSON.parse(text);

      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
        results.push(...parsed['@graph']);
      } else {
        results.push(parsed);
      }
    } catch (err) {
      log.debug('Failed to parse JSON-LD block', { error: String(err) });
    }
  }

  return results;
}

export function matchJsonLdToSchema(
  jsonLdBlocks: Record<string, unknown>[],
  schema: JsonSchema,
): Record<string, unknown> {
  if (!schema.properties || jsonLdBlocks.length === 0) return {};

  const result: Record<string, unknown> = {};
  const flattened = flattenJsonLd(jsonLdBlocks);

  for (const fieldName of Object.keys(schema.properties)) {
    if (flattened[fieldName] !== undefined) {
      result[fieldName] = flattened[fieldName];
    }
  }

  return result;
}

function flattenJsonLd(
  blocks: Record<string, unknown>[],
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  for (const block of blocks) {
    flattenObject(block, flat);
  }

  return flat;
}

function flattenObject(
  obj: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;

    if (!(key in target)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        flattenObject(value as Record<string, unknown>, target);
      } else {
        target[key] = value;
      }
    }
  }
}
