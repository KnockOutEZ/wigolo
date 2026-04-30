import { parseHTML } from 'linkedom';
import { createLogger } from '../logger.js';
import type { StructuredDataResult } from '../types.js';

const log = createLogger('structured-data');

const KNOWN_TYPES = new Set([
  'Article',
  'Product',
  'Recipe',
  'BreadcrumbList',
  'Organization',
  'Person',
]);

export function extractStructuredData(html: string): StructuredDataResult[] {
  if (!html) return [];
  const { document: doc } = parseHTML(html);
  const out: StructuredDataResult[] = [];
  out.push(...extractJsonLdBlocks(doc));
  // microdata and rdfa added in later steps
  return out;
}

function extractJsonLdBlocks(doc: Document): StructuredDataResult[] {
  const out: StructuredDataResult[] = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    const text = script.textContent?.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log.warn('Failed to parse JSON-LD block', { error: String(err) });
      continue;
    }
    for (const node of flattenJsonLd(parsed)) {
      const type = normalizeType(node['@type']);
      if (!type) continue;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('@')) continue;
        fields[k] = v;
      }
      out.push({ provenance: 'json-ld', type, fields });
    }
  }
  return out;
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) return obj['@graph'].flatMap(flattenJsonLd);
  return [obj];
}

function normalizeType(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const tail = raw.split('/').pop()!;
    return tail || null;
  }
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const norm = normalizeType(t);
      if (norm) return norm;
    }
  }
  return null;
}

export const KNOWN_SCHEMA_TYPES: ReadonlySet<string> = KNOWN_TYPES;
