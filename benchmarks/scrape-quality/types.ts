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

export type Category = 'markdown_fidelity' | 'table_preservation' | 'boilerplate_noise' | 'structured_extract';

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
  | { kind: 'table_cell'; category: Category; value: string; why: string };

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
