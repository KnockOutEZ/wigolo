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
  out.push(...extractMicrodataBlocks(doc));
  // rdfa added in a later step
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

function extractMicrodataBlocks(doc: Document): StructuredDataResult[] {
  const out: StructuredDataResult[] = [];
  // Top-level itemscopes only — nested itemscopes are walked into as fields.
  const all = Array.from(doc.querySelectorAll('[itemscope]'));
  const tops = all.filter((el) => !hasItemscopeAncestor(el));
  for (const el of tops) {
    const node = readMicrodataNode(el);
    if (!node) continue;
    out.push(node);
  }
  return out;
}

function hasItemscopeAncestor(el: Element): boolean {
  let cur = el.parentElement;
  while (cur) {
    if (cur.hasAttribute('itemscope')) return true;
    cur = cur.parentElement;
  }
  return false;
}

function readMicrodataNode(el: Element): StructuredDataResult | null {
  const itemtype = el.getAttribute('itemtype') ?? '';
  const type = itemtype ? itemtype.split('/').pop()! : '';
  if (!type) return null;
  const fields: Record<string, unknown> = {};
  // Walk descendants but stop crossing into nested itemscopes (handle them as nested objects)
  collectItemprops(el, fields);
  return { provenance: 'microdata', type, fields };
}

function collectItemprops(root: Element, target: Record<string, unknown>): void {
  const stack: Element[] = Array.from(root.children);
  while (stack.length) {
    const el = stack.shift()!;
    const prop = el.getAttribute('itemprop');
    if (prop) {
      let value: unknown;
      if (el.hasAttribute('itemscope')) {
        const nested: Record<string, unknown> = {};
        collectItemprops(el, nested);
        value = nested;
      } else {
        value =
          el.getAttribute('content') ??
          el.getAttribute('href') ??
          el.getAttribute('src') ??
          (el.textContent ?? '').trim();
      }
      mergeProp(target, prop, value);
    }
    // Always stop at any itemscope: it is an independent item, regardless of
    // whether it carries an itemprop. Otherwise its descendants' itemprops
    // would leak into the parent record.
    if (el.hasAttribute('itemscope')) continue;
    for (const c of el.children) stack.push(c);
  }
}

function mergeProp(target: Record<string, unknown>, prop: string, value: unknown): void {
  if (target[prop] === undefined) {
    target[prop] = value;
    return;
  }
  if (Array.isArray(target[prop])) {
    (target[prop] as unknown[]).push(value);
    return;
  }
  target[prop] = [target[prop], value];
}

export const KNOWN_SCHEMA_TYPES: ReadonlySet<string> = KNOWN_TYPES;
