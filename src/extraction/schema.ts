import { parseHTML } from 'linkedom';
import { extractStructuredData } from './structured-data.js';
import { extractStructured } from './structured.js';
import { extractWithLLM, type LLMFallbackBudget } from './llm-fallback.js';
import { applyEvidenceFilter, getSourceText } from './schema-truth.js';
import type {
  FieldProvenance,
  GridConfidence,
  SchemaExtractionResult,
  StructuredData,
  StructuredDataResult,
} from '../types.js';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
}

export interface SchemaExtractionOpts {
  signal?: AbortSignal;
  budget?: LLMFallbackBudget;
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
  const confidence: Record<string, GridConfidence> = {};
  const withConfidence = (r: SchemaExtractionResult): SchemaExtractionResult =>
    Object.keys(confidence).length > 0 ? { ...r, confidence } : r;
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

  const allCovered = () =>
    Object.keys(schema.properties!).every((k) => values[k] !== undefined);
  if (allCovered()) return withConfidence({ values, provenance });

  // Structure fuzzy-match: when data lives in tables / definition lists /
  // key-value pairs (not JSON-LD or class-named DOM), fuzzy-match remaining
  // schema fields against those extracted structures. This is why a page
  // whose facts sit in a <table> used to return {} — the keyless path never
  // consulted extractStructured. Fuzzy = token overlap / substring /
  // snake↔space↔camel folding; provenance = 'structured'.
  const structured = extractStructured(html);
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    if (values[fieldName] !== undefined) continue;
    // An array-of-objects field (e.g. tiers:[{name,price,key_features}]) maps
    // to a whole grid: one item object per row, each item property fuzzy-matched
    // to a header. Try this first so `wigolo agent` gets clean structured rows
    // instead of falling through to the run-on class-name heuristic.
    const grid = matchArrayOfObjectsFromStructures(fieldSchema, structured);
    if (grid !== undefined) {
      values[fieldName] = grid.rows;
      provenance[fieldName] = 'structured';
      confidence[fieldName] = {
        score: grid.score,
        scalarMatches: grid.scalarMatches,
        arrayFilled: grid.arrayFilled,
        rowCount: grid.rows.length,
      };
      continue;
    }
    const v = matchFieldFromStructures(fieldName, structured);
    if (v !== undefined) {
      values[fieldName] = v;
      provenance[fieldName] = 'structured';
    }
  }

  if (allCovered()) return withConfidence({ values, provenance });

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

  return withConfidence({ values, provenance });
}

// ---------- structure fuzzy-match helpers ----------

// Fold a label into comparable tokens: lowercase, split on
// snake_case / camelCase / spaces / hyphens, drop empties.
function foldTokens(label: string): string[] {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Two tokens refer to the same thing when they are equal or differ only by a
// trailing plural `s` (plan ↔ plans). Deliberately NOT substring containment:
// that matched plan→planet, card→cardholder, tier→frontier, name→username and
// broke the "no false positives" invariant.
function tokensEqual(x: string, y: string): boolean {
  if (x === y) return true;
  if (x.length >= 3 && y === `${x}s`) return true;
  if (y.length >= 3 && x === `${y}s`) return true;
  return false;
}

// Do a schema field name and a structure key/header refer to the same thing?
// Full token-set overlap with plural-tolerant token equality: every token of
// the shorter side must have a match in the longer side. This folds
// `plan_name` ↔ `Plan Name` ↔ `planName` and `plan` ↔ `plans` while rejecting
// near-miss substrings (planet / cardholder / frontier / username).
function labelsMatch(fieldName: string, candidate: string): boolean {
  const a = foldTokens(fieldName);
  const b = foldTokens(candidate);
  if (a.length === 0 || b.length === 0) return false;

  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  for (const t of small) {
    if (!big.some((u) => tokensEqual(t, u))) return false;
  }
  return true;
}

// Fuzzy-match one schema field against extracted key-value pairs, definition
// terms, and table headers (header→cell value). Returns the first confident
// match, or undefined when nothing corresponds (no false positives).
function matchFieldFromStructures(
  fieldName: string,
  structured: StructuredData,
): string | undefined {
  for (const kv of structured.key_value_pairs) {
    if (labelsMatch(fieldName, kv.key)) return kv.value;
  }

  for (const def of structured.definitions) {
    if (labelsMatch(fieldName, def.term)) return def.description;
  }

  for (const table of structured.tables) {
    for (let i = 0; i < table.headers.length; i++) {
      const header = table.headers[i];
      if (!labelsMatch(fieldName, header)) continue;
      for (const row of table.rows) {
        const cell = row[header];
        if (cell !== undefined && cell !== '') return cell;
      }
    }
  }

  return undefined;
}

// Map an array-of-objects schema field (e.g. tiers:[{name,price,key_features}])
// onto the best-matching extracted grid: one item object per row, each item
// property fuzzy-matched to a table header. Shared by the extract tool and the
// agent pipeline; this is why the agent used to return prose for pricing pages
// whose tiers lived in a <table> or div-grid.
//
// No-false-positive gate: a grid only qualifies when at least MIN_ITEM_MATCHES
// (or all, for a 1-property item schema) of the item properties fuzzy-match a
// header — an unrelated grid (weather / SERP) whose headers match nothing
// yields undefined, never an array of junk rows.
//
// Among the grids that qualify, SELECTION is semantic, not first-wins: a
// pricing page carries both plan tiers (name+price+features, a handful of rows)
// and an add-ons / resources section (name+price, many rows). First-wins let
// the add-on dump win purely by DOM order. We score every qualifying grid by
// shape completeness (more matched props + array props actually filled) with a
// SOFT plausibility prior (plan lists are typically 2-6 rows) and return the
// best — never truncating or dropping the losing grid's rows, only preferring
// the fuller-shaped, plausibly-sized one.
const MIN_ITEM_MATCHES = 2;

// Header prefix the div-grid detector emits for a card's list items — the
// natural source for an array-typed item property (e.g. key_features).
const FEATURE_HEADER_RE = /^feature[_-]?\d+$/i;

// A schema property named "name"/"title"/"label" refers to the same thing as a
// tier grid's identity column even when that column is headed "Plan", "Tier",
// "Product", or "Package". labelsMatch alone rejects these (different tokens),
// so a `name` property would fail to bind on a table whose header is "Plan" and
// the whole tier grid would drop below the match gate. The synonym is scoped to
// identity columns only — it never widens price/feature matching.
const NAME_PROP_TOKENS = new Set(['name', 'title', 'label']);
const NAME_HEADER_TOKENS = new Set([
  'name',
  'title',
  'label',
  'plan',
  'tier',
  'product',
  'package',
]);

// Does an item property bind to a header, allowing the name<->plan/tier synonym
// for single-token identity columns? Plural-tolerant token equality still gates
// multi-token labels via labelsMatch.
function propMatchesHeader(prop: string, header: string): boolean {
  if (labelsMatch(prop, header)) return true;
  const p = foldTokens(prop);
  const h = foldTokens(header);
  if (p.length !== 1 || h.length !== 1) return false;
  return NAME_PROP_TOKENS.has(p[0]) && NAME_HEADER_TOKENS.has(h[0]);
}

// Typical plan/tier list size. Used ONLY as a soft ranking preference — it never
// filters rows or excludes a grid, so a legitimate 8-tier page keeps all 8 rows.
const PLAUSIBLE_MIN = 2;
const PLAUSIBLE_MAX = 6;

interface GridCandidate {
  rows: Array<Record<string, string | string[]>>;
  score: number;
  scalarMatches: number;
  arrayFilled: boolean;
}

function scoreCandidate(
  scalarMatches: number,
  arrayFilled: boolean,
  rowCount: number,
): number {
  // Shape completeness dominates: each bound scalar property is worth far more
  // than the size prior, so a name+price+features tier grid outranks a
  // name+price add-on dump regardless of DOM order or row count.
  let score = scalarMatches * 10;
  if (arrayFilled) score += 10;
  // Soft plausibility prior: a small nudge toward plan-sized grids, bounded so
  // it can only break ties between equally-shaped grids — never override a real
  // shape-completeness difference and never drop the larger grid's rows.
  if (rowCount >= PLAUSIBLE_MIN && rowCount <= PLAUSIBLE_MAX) score += 3;
  return score;
}

function matchArrayOfObjectsFromStructures(
  fieldSchema: JsonSchema,
  structured: StructuredData,
): GridCandidate | undefined {
  if (fieldSchema.type !== 'array') return undefined;
  const items = fieldSchema.items;
  if (!items || items.type !== 'object' || !items.properties) return undefined;

  const itemProps = Object.entries(items.properties);
  if (itemProps.length === 0) return undefined;

  let best: GridCandidate | undefined;
  for (const table of structured.tables) {
    if (table.headers.length === 0 || table.rows.length === 0) continue;

    // Resolve each scalar item property to the first header it binds to
    // (name<->plan/tier synonym included). Array-typed item properties (e.g.
    // key_features) collect the card's feature_* columns instead, so a
    // div-grid's per-item list surfaces as an array rather than being dropped.
    const scalarProps = new Map<string, string>();
    const arrayProps: string[] = [];
    const claimedHeaders = new Set<string>();
    for (const [prop, propSchema] of itemProps) {
      const header = table.headers.find(
        (h) => !claimedHeaders.has(h) && propMatchesHeader(prop, h),
      );
      if (header) {
        scalarProps.set(prop, header);
        claimedHeaders.add(header);
      } else if (propSchema.type === 'array') {
        arrayProps.push(prop);
      }
    }

    const featureHeaders = table.headers.filter(
      (h) => FEATURE_HEADER_RE.test(h) && !claimedHeaders.has(h),
    );

    // The scalar matches are the no-false-positive gate; an array property that
    // only harvests generic feature_* columns is NOT sufficient on its own.
    const required = Math.min(itemProps.length, MIN_ITEM_MATCHES);
    if (scalarProps.size < required) continue;

    const rows: Array<Record<string, string | string[]>> = [];
    let arrayFilled = false;
    for (const row of table.rows) {
      const obj: Record<string, string | string[]> = {};
      for (const [prop, header] of scalarProps) {
        const cell = row[header];
        if (cell !== undefined && cell !== '') obj[prop] = cell;
      }
      if (featureHeaders.length > 0 && arrayProps.length > 0) {
        const features = featureHeaders
          .map((h) => row[h])
          .filter((v): v is string => v !== undefined && v !== '');
        if (features.length > 0) {
          for (const prop of arrayProps) obj[prop] = features;
          arrayFilled = true;
        }
      }
      if (Object.keys(obj).length > 0) rows.push(obj);
    }
    if (rows.length === 0) continue;

    const score = scoreCandidate(scalarProps.size, arrayFilled, rows.length);
    if (!best || score > best.score) {
      best = { rows, score, scalarMatches: scalarProps.size, arrayFilled };
    }
  }

  return best;
}

export interface SchemaExtractionAsyncResult extends SchemaExtractionResult {
  warnings: string[];
}

export async function extractWithSchemaDetailedAsync(
  html: string,
  schema: JsonSchema,
  opts: SchemaExtractionOpts = {},
): Promise<SchemaExtractionAsyncResult> {
  const det = extractWithSchemaDetailed(html, schema);

  if (!schema.required || schema.required.length === 0) {
    return { ...det, warnings: [] };
  }

  const missing = schema.required.filter((k) => det.values[k] === undefined);
  if (missing.length === 0) {
    return { ...det, warnings: [] };
  }

  const llm = await extractWithLLM({
    html,
    jsonSchema: schema as unknown as Record<string, unknown>,
    partial: det.values,
    missing,
    signal: opts.signal,
    budget: opts.budget,
  });

  const values = { ...det.values };
  const provenance: Record<string, FieldProvenance> = { ...det.provenance };
  const llmFilledFields: string[] = [];
  for (const key of missing) {
    if (llm.values[key] !== undefined && values[key] === undefined) {
      values[key] = llm.values[key];
      provenance[key] = 'llm';
      llmFilledFields.push(key);
    }
  }

  // Evidence-only constraint (C1): every LLM-sourced field must have its
  // value present in the source text (or be a trivial derivative). The LLM
  // can free-form-complete a confidently-wrong answer; the verifier nulls
  // those out so callers never see hallucinated facts.
  const warnings = [...llm.warnings];
  if (llmFilledFields.length > 0) {
    const sourceText = getSourceText(html);
    const filtered = applyEvidenceFilter({
      values,
      provenance,
      sourceText,
      fields: llmFilledFields,
    });
    if (filtered.rejectedFields.length > 0) {
      warnings.push(
        `evidence-only filter: nulled ${filtered.rejectedFields.length} ` +
          `field(s) the LLM proposed but were not present in source text ` +
          `(${filtered.rejectedFields.join(', ')}).`,
      );
    }
    return { values: filtered.values, provenance, warnings };
  }

  return { values, provenance, warnings };
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
