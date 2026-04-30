import { parseHTML } from 'linkedom';
import { extractStructuredData } from './structured-data.js';
import type {
  FieldProvenance,
  SchemaExtractionResult,
  StructuredDataResult,
} from '../types.js';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

const PROVENANCE_PRIORITY: StructuredDataResult['provenance'][] = [
  'json-ld',
  'microdata',
  'rdfa',
];

export function extractWithSchema(
  html: string,
  schema: JsonSchema,
): Record<string, unknown> {
  return extractWithSchemaDetailed(html, schema).values;
}

export function extractWithSchemaDetailed(
  html: string,
  schema: JsonSchema,
): SchemaExtractionResult {
  const values: Record<string, unknown> = {};
  const provenance: Record<string, FieldProvenance> = {};
  if (!html || !schema.properties) return { values, provenance };

  const blocks = extractStructuredData(html);

  for (const source of PROVENANCE_PRIORITY) {
    for (const block of blocks) {
      if (block.provenance !== source) continue;
      for (const fieldName of Object.keys(schema.properties)) {
        if (values[fieldName] !== undefined) continue;
        const v = pickField(block.fields, fieldName);
        if (v !== undefined) {
          values[fieldName] = v;
          provenance[fieldName] = source;
        }
      }
    }
  }

  const allCovered = Object.keys(schema.properties).every(
    (k) => values[k] !== undefined,
  );
  if (allCovered) return { values, provenance };

  // Heuristic fallback only for fields still missing
  const { document: doc } = parseHTML(html);
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    if (values[fieldName] !== undefined) continue;
    const v = findFieldValue(doc, fieldName, fieldSchema);
    if (v !== undefined) {
      values[fieldName] = v;
      provenance[fieldName] = 'heuristic';
    }
  }

  return { values, provenance };
}

function pickField(fields: Record<string, unknown>, name: string): unknown {
  if (fields[name] !== undefined) return fields[name];
  // Shallow nested — e.g. JSON-LD Product.offers.price
  for (const v of Object.values(fields)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = (v as Record<string, unknown>)[name];
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

// ---------- heuristic helpers (preserved from prior schema.ts) ----------

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
    const byItemprop = doc.querySelector(`[itemprop="${name}"]`);
    if (byItemprop) {
      const text = byItemprop.getAttribute('content') ?? byItemprop.textContent?.trim();
      if (text) return text;
    }

    const byClass = doc.querySelector(`[class*="${name}"]`);
    if (byClass) {
      const text = byClass.textContent?.trim();
      if (text) return text;
    }

    const allWithAria = doc.querySelectorAll('[aria-label]');
    for (const el of allWithAria) {
      const label = el.getAttribute('aria-label')?.toLowerCase().replace(/\s+/g, '-') ?? '';
      if (label === name.toLowerCase()) {
        const text = el.textContent?.trim();
        if (text) return text;
      }
    }

    const byId = doc.querySelector(`#${cssEscape(name)}`);
    if (byId) {
      const text = byId.textContent?.trim();
      if (text) return text;
    }

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
