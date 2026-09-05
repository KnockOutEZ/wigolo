import type { JsonSchema } from '../../src/extraction/schema.js';
import type { FieldProvenance, SchemaExtractionResult } from '../../src/types.js';

/**
 * C0 referee — scrape-quality benchmark types.
 *
 * Deliberately assertion-based rather than golden-diff based. A golden markdown file
 * for a real third-party page has to be hand-maintained and goes stale the moment the
 * extractor legitimately improves, which is why the existing extraction corpus rotted
 * (21 goldens, zero HTML inputs, runner with no entry point, workflow red since at
 * least 2026-06-29). Assertions state what MUST survive extraction and stay true across
 * legitimate extractor changes; a regression is an assertion that stops holding.
 */

export type Category =
  | 'markdown_fidelity'
  | 'table_preservation'
  | 'boilerplate_noise'
  /**
   * Scores `extractStructured` — the structured MODE. It is NOT about schema mode, and C2
   * spec §13.1 warns in as many words that its C0 7/7 = 1.0 "must not be read as a schema-mode
   * baseline". `schema_extract` below is the separate bucket that supplies the missing one.
   */
  | 'structured_extract'
  /**
   * SD9-Q1 — scores `extractWithSchemaDetailed` (`src/extraction/schema.ts:39`), the mode a
   * caller reaches through `extract mode:"schema"`. Deliberately a NEW category rather than
   * more rows inside `structured_extract`: overloading that name would make the existing 7/7
   * and the schema number indistinguishable in `byCategory`, which is the only place a gate
   * can read either of them (C2 spec §, "New category `schema_extract` … not folded into
   * `structured_extract`").
   */
  | 'schema_extract';

/** One checkable claim about the extracted output. */
export type Assertion =
  /** Extracted markdown must contain this exact substring (a heading, a code token, a cell value). */
  | { kind: 'contains'; category: Category; value: string; why: string }
  /** Extracted markdown must NOT contain this substring (nav chrome, cookie banner, footer). */
  | { kind: 'absent'; category: Category; value: string; why: string }
  /** Count of a markdown feature must land in [min, max]. */
  | { kind: 'count'; category: Category; feature: MarkdownFeature; min: number; max: number; why: string }
  /** Structured extraction must surface at least `min` items of this kind. */
  | { kind: 'structured'; category: Category; field: StructuredField; min: number; why: string }
  /** Some table produced by structured extraction must contain this cell text. */
  | { kind: 'table_cell'; category: Category; value: string; why: string }
  /**
   * S12-0 — this text IS in the source HTML and must NOT survive extraction, because the
   * human cannot see it (display:none, a collapsed <details>, an off-screen tab panel).
   *
   * Deliberately NOT the same as `absent`: `absent` means "boilerplate, should never be
   * extracted from anywhere". `visible_only` means "real content that happens to be
   * invisible", and it carries a NON-VACUITY obligation the others do not — the value must
   * be present in the source HTML, or the assertion is scoring nothing. A fixture typo that
   * made the string unfindable would otherwise read as a free pass forever.
   */
  | { kind: 'visible_only'; category: Category; value: string; why: string }
  /** S12-0 — a recipe replay must produce exactly this column set. Drift corpus only. */
  | { kind: 'row_columns'; category: Category; expect: string[]; why: string }
  /** S12-0 — a recipe replay's row count must land in [min, max]. Drift corpus only. */
  | { kind: 'row_count'; category: Category; min: number; max: number; why: string }
  /** S12-0 — a recipe replay's heal verdict must be at least this tier. Drift corpus only. */
  | { kind: 'heal_at_least'; category: Category; tier: 'high' | 'medium'; why: string }
  /**
   * SD9-Q1 — schema mode must produce this text for this field. `exact` compares the whole
   * normalised value; the default is containment, which is what a nested object (a JSON-LD
   * `author`) needs since its value is stringified before the comparison.
   */
  | { kind: 'schema_value'; category: Category; field: string; value: string; exact?: boolean; why: string }
  /** SD9-Q1 — an array-of-objects schema field must resolve to at least `min` rows. */
  | { kind: 'schema_rows'; category: Category; field: string; min: number; why: string }
  /**
   * SD9-Q1 — at least `minFilled` of an array field's rows must carry a non-empty `column`.
   * Row COUNT alone does not make a grid joinable: a 206-row grid whose join key is filled on
   * 12 rows synthesises nothing across tabs. Density is the property 3ab actually stands on.
   */
  | { kind: 'schema_row_field'; category: Category; field: string; column: string; minFilled: number; why: string }
  /**
   * SD9-Q1 — the field must have been resolved from one of these sources. Provenance is not
   * decoration here: a value that silently moved from `json-ld` to the fuzzy `structured` path
   * has changed how much it can be trusted while its text stayed identical.
   */
  | { kind: 'schema_provenance'; category: Category; field: string; expect: FieldProvenance[]; why: string }
  /**
   * SD9-Q1 — a field the schema ASKS FOR and the page does not answer must come back
   * unpopulated. The fuzzy structure-matching limb (`schema.ts:74`) is the thing this
   * constrains: it folds snake/space/camel and matches on token overlap, so it can plausibly
   * attach some row's cell to a field the page never carried. A schema-mode baseline made only
   * of positive rows would score an extractor that answers everything as perfect.
   */
  | { kind: 'schema_absent'; category: Category; field: string; why: string };

/**
 * The assertion kinds that score a RECIPE REPLAY rather than an extraction pass. They are
 * unevaluable without a replay outcome, so they belong to the drift corpus and never to the
 * C0 fixture manifest — `validateCorpus` enforces that separation, because an unevaluable
 * assertion sitting in the blocking lane would either fail forever or (worse) be softened
 * into a pass and quietly stop measuring.
 */
export const REPLAY_ASSERTION_KINDS = ['row_columns', 'row_count', 'heal_at_least'] as const;
export type ReplayAssertionKind = (typeof REPLAY_ASSERTION_KINDS)[number];

/**
 * SD9-Q1 — the assertion kinds scored against a SCHEMA-MODE extraction rather than against
 * markdown. They need `AssertionContext.schema`, so any lane that cannot supply one must skip
 * them rather than score them: the competitor lane returns markdown only, and scoring a schema
 * row there would compare wigolo against an absent capability, exactly as `structured` and
 * `table_cell` already are dropped in `firecrawl.ts`.
 */
export const SCHEMA_ASSERTION_KINDS = [
  'schema_value',
  'schema_rows',
  'schema_row_field',
  'schema_provenance',
  'schema_absent',
] as const;
export type SchemaAssertionKind = (typeof SCHEMA_ASSERTION_KINDS)[number];

/** Heal verdict tiers, mirroring `src/studio/mark/heal.ts:22`. */
export type HealTier = 'high' | 'medium' | 'low' | 'none';

/** What a recipe replay produced, for the three replay assertion kinds to score. */
export interface ReplayOutcome {
  columns: string[];
  rowCount: number;
  healTier: HealTier;
}

/**
 * Extra inputs some assertion kinds need beyond the extracted markdown.
 *
 * Every field is optional, and every kind that needs one FAILS LOUDLY when it is absent
 * rather than passing. A missing input that read as a pass is the exact shape of the vacuous
 * control this program has been caught by three times.
 */
export interface AssertionContext {
  /** The HTML extraction ran on. Required by `visible_only` for its non-vacuity check. */
  sourceHtml?: string;
  /** A recipe replay's outcome. Required by the three replay kinds. */
  replay?: ReplayOutcome;
  /** SD9-Q1 — schema-mode output plus the schema it answered. Required by the schema kinds. */
  schema?: SchemaProbe;
}

/**
 * SD9-Q1 — what a schema-mode row is scored against.
 *
 * `declared` is carried alongside `result` because every schema assertion's non-vacuity check
 * is "is this field in the schema we asked for". A row naming a field the fixture never
 * declared is unevaluable, and `schema_absent` is the kind that makes that fatal: an
 * undeclared field is unpopulated for the life of the corpus, so the row would score a free
 * point forever — the same free-pass shape the `absent` kind was already caught by.
 */
export interface SchemaProbe {
  declared: JsonSchema;
  result: SchemaExtractionResult;
}

export type MarkdownFeature = 'heading' | 'table_row' | 'link' | 'code_block' | 'list_item' | 'char';
export type StructuredField = 'tables' | 'definitions' | 'jsonld' | 'chart_hints' | 'key_value_pairs';

export interface ScrapeFixture {
  id: string;
  /** The URL the snapshot came from — passed to the extractor so site rules apply. */
  url: string;
  /** Page class, for the per-class view in the report. */
  pageClass: string;
  /** Snapshot file, relative to fixtures/html. */
  htmlPath: string;
  /** When the snapshot was taken. Snapshots are frozen; they are never re-fetched by the gate. */
  capturedAt: string;
  /** Licence of the snapshotted content, so the corpus stays auditable. */
  licence: string;
  /**
   * SD9-Q1 — the JSON Schema this fixture's schema-mode rows are scored against. Present only
   * on schema-mode fixtures; a fixture without one supplies no `SchemaProbe`, and any schema
   * assertion on it fails loudly rather than passing.
   */
  schema?: JsonSchema;
  assertions: Assertion[];
}

export interface ScrapeManifest {
  version: string;
  /** Provenance of the URL selection, not of the page content. */
  corpusSource: string;
  fixtures: ScrapeFixture[];
}

export interface AssertionResult {
  category: Category;
  passed: boolean;
  describe: string;
  detail?: string;
}

export interface FixtureResult {
  id: string;
  url: string;
  pageClass: string;
  extractor: string;
  markdownChars: number;
  ms: number;
  error?: string;
  assertions: AssertionResult[];
  /** Fraction of assertions passed, per category present on this fixture. */
  categoryScores: Partial<Record<Category, number>>;
}

export interface CategorySummary {
  passed: number;
  total: number;
  score: number;
}

export interface ScrapeReport {
  runDate: string;
  durationMs: number;
  overall: { passed: number; total: number; score: number };
  byCategory: Record<Category, CategorySummary>;
  byPageClass: Record<string, CategorySummary>;
  fixtures: FixtureResult[];
}

/** The committed pre-S9 snapshot the PR gate compares against. */
export interface Baseline {
  takenAt: string;
  commit: string;
  note: string;
  overall: { passed: number; total: number; score: number };
  byCategory: Record<string, CategorySummary>;
  /** Per-assertion verdicts, so the gate can name exactly which claim broke. */
  assertions: Record<string, boolean>;
}
