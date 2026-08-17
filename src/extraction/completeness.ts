import { parseHTML } from 'linkedom';
import type { ContentCompleteness } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('extract');

/**
 * Minimum titled rows before the ratio is allowed to decide anything.
 *
 * The floor is what keeps the gate honest: at N = 5 the finest ratio step is
 * 1/5 = 0.2, comfortably coarser than the 0.5 threshold, so firing always
 * means "at least 3 of 5 rows were gutted" and never degenerates into a secret
 * "zero survived" test. Below the floor a listing is short enough that a single
 * row swings the ratio past the threshold, so we refuse to judge.
 */
const MIN_TITLED_ROWS = 5;

/** Fire when at least half the titled rows came back gutted. */
const GUTTED_ROW_RATIO = 0.5;

/**
 * Fraction of a title's distinctive tokens that must appear in the output
 * before the title counts as surviving. Below 1.0 so a title the extractor
 * kept but reflowed (an inline link splitting it, a badge glued on) still
 * reads as present — the error direction here is deliberately "assume it
 * survived", because a false silence is far cheaper than a false alarm.
 */
const TITLE_TOKEN_COVERAGE = 0.6;

/**
 * How much of an OUTPUT row must be explained by one source row before we
 * accept they are the same row.
 *
 * The direction matters. Asking "did the source row survive intact" fails on
 * real listings, because an extractor legitimately strips per-row chrome —
 * labels, badges, icons — so a surviving row keeps only a fraction of its
 * original tokens. Asking instead "is this output row accounted for by that
 * source row" tolerates that stripping while still refusing to match rows that
 * merely share a stray word.
 */
const OUTPUT_ROW_EXPLAINED = 0.5;

/**
 * Absolute overlap floor, so a two-word output row ("Status: Open.") cannot
 * vouch for a source row on generic vocabulary alone. Ratios are meaningless at
 * that size; this is the guard that makes the ratio safe to apply.
 */
const MIN_SHARED_TOKENS = 3;

const LIST_ROW_SELECTOR = 'li, [role="listitem"]';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const BULLET_LINE = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+\S/;

/**
 * Unicode-aware tokenizer. Splitting on non letter/number keeps accented and
 * non-Latin titles intact — an ASCII-only class would shred "criação" into
 * fragments and make a present title look missing.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
}

function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function coverage(tokens: string[], present: Set<string>): number {
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => present.has(t)).length / tokens.length;
}

/**
 * Drop link targets, keeping link text. A markdown URL contributes a dozen
 * slug and query tokens that are not content; left in, they dilute every ratio
 * computed over an output row and make a genuinely matching row look unrelated.
 */
function stripLinkTargets(markdown: string): string {
  return markdown.replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ']').replace(/<https?:\/\/[^>]*>/g, '');
}

/**
 * Split markdown into one token-set per list row. A row starts at a bullet line
 * and runs until the next one, so an indented continuation (the metadata line
 * under a listing entry) stays attached to the row it belongs to.
 */
function outputRowTokenSets(markdown: string): Set<string>[] {
  const blocks: string[][] = [];
  for (const line of stripLinkTargets(markdown).split('\n')) {
    if (BULLET_LINE.test(line)) blocks.push([line]);
    else if (blocks.length > 0) blocks[blocks.length - 1].push(line);
  }
  return blocks.map((lines) => new Set(tokenize(lines.join('\n'))));
}

interface SourceRow {
  titleTokens: string[];
  residueTokens: string[];
}

/** Rows in the source that demonstrably carried a title we can check for. */
function readTitledRows(sourceHtml: string): SourceRow[] | undefined {
  let document;
  try {
    ({ document } = parseHTML(sourceHtml));
  } catch (err) {
    log.debug('completeness assessment skipped — parse failed', { error: String(err) });
    return undefined;
  }

  const rows: SourceRow[] = [];
  for (const row of new Set(document.querySelectorAll(LIST_ROW_SELECTOR))) {
    const heading = row.querySelector(HEADING_SELECTOR);
    if (!heading) continue;
    // A heading inside a NESTED row belongs to that row, not this one. Without
    // this an outer <li> borrows its children's titles and a 3-item list can
    // clear a floor that exists precisely to keep small lists out.
    if (heading.closest(LIST_ROW_SELECTOR) !== row) continue;

    const titleText = heading.textContent ?? '';
    const titleTokens = uniqueTokens(titleText);
    // A one-token heading ("Bug:", "Docs") carries too little signal to tell
    // survival from coincidence, so it never joins the denominator.
    if (titleTokens.length < 2) continue;

    // Residue = everything in the row that is not its title. Set subtraction
    // rather than DOM surgery: a token carried by both the title and the row
    // body is ambiguous evidence, so dropping it makes the match stricter.
    const titleSet = new Set(titleTokens);
    const residueTokens = uniqueTokens(row.textContent ?? '').filter((t) => !titleSet.has(t));

    rows.push({ titleTokens, residueTokens });
  }
  return rows;
}

export interface ListTitleAttrition {
  /** Rows in the extractor's input that carried a checkable title. */
  titledRows: number;
  /** Rows still present in the output whose title did not come with them. */
  guttedRows: number;
  verdict?: ContentCompleteness;
}

/**
 * Detects the "silent partial shell": an extraction whose list rows survived
 * but whose row titles did not.
 *
 * This is a differential between the HTML handed to the extractor and the
 * markdown it produced, so it can only ever fire on titles we can prove were
 * present in the input. That is what makes it safe to run on every tier — it
 * needs no render observation, no same-origin norm and no network, which is
 * why it reaches the HTTP and TLS tiers that the browser-tier settle verdict
 * structurally cannot.
 *
 * A row counts as gutted only when its own non-title text is matched against a
 * SINGLE output row. That per-row scoping is what separates real harm from
 * correct behaviour: an extractor that drops a related-links rail leaves those
 * rows unmatched and stays silent even when the article it kept is full of
 * unrelated bullets, while an extractor that keeps twelve rows and throws away
 * eleven titles hands the caller something that merely looks complete.
 */
export function analyzeListTitleAttrition(
  sourceHtml: string,
  markdown: string,
): ListTitleAttrition {
  const empty: ListTitleAttrition = { titledRows: 0, guttedRows: 0 };
  if (!sourceHtml || !markdown) return empty;

  // Cheap pre-filter so the common article/docs page never pays for a parse.
  // Firing needs at least half of MIN_TITLED_ROWS rows matched to output rows,
  // so fewer output rows than that can never fire.
  const outputRows = outputRowTokenSets(markdown);
  if (outputRows.length < Math.ceil(MIN_TITLED_ROWS * GUTTED_ROW_RATIO)) return empty;

  const sourceRows = readTitledRows(sourceHtml);
  if (!sourceRows) return empty;

  const titledRows = sourceRows.length;
  if (titledRows < MIN_TITLED_ROWS) return { titledRows, guttedRows: 0 };

  const allOutputTokens = new Set(tokenize(stripLinkTargets(markdown)));
  let guttedRows = 0;
  for (const row of sourceRows) {
    // Title survival is judged page-wide: if the words show up anywhere we give
    // the extractor the benefit of the doubt and do not count the row.
    if (coverage(row.titleTokens, allOutputTokens) >= TITLE_TOKEN_COVERAGE) continue;
    const residueSet = new Set(row.residueTokens);
    // Survival of the row ITSELF must be pinned to ONE output row.
    const stillPresent = outputRows.some((out) => {
      const shared = [...out].filter((t) => residueSet.has(t)).length;
      return shared >= MIN_SHARED_TOKENS && shared / out.size >= OUTPUT_ROW_EXPLAINED;
    });
    if (stillPresent) guttedRows++;
  }

  if (guttedRows < titledRows * GUTTED_ROW_RATIO) return { titledRows, guttedRows };

  log.debug('list title attrition detected', { titledRows, guttedRows });
  return {
    titledRows,
    guttedRows,
    verdict: { level: 'partial', reason: 'list_titles_dropped', settled_by: 'extraction' },
  };
}

/**
 * Verdict-only wrapper. Returns `undefined` when the page is fine — callers omit
 * the field entirely rather than emitting a "full" claim this predicate is not
 * entitled to make.
 */
export function assessListTitleAttrition(
  sourceHtml: string,
  markdown: string,
): ContentCompleteness | undefined {
  return analyzeListTitleAttrition(sourceHtml, markdown).verdict;
}

const SEVERITY: Record<ContentCompleteness['level'], number> = {
  full: 0,
  partial: 1,
  shell: 2,
};

/**
 * Reconcile the two producers of a completeness verdict.
 *
 * The browser tier reports how far a page RENDERED; the extraction seam reports
 * whether content present in the HTML survived being extracted. They answer
 * different questions, so neither is authoritative over the other — and the
 * browser tier emits `full` as its ordinary outcome, which means a plain
 * "render verdict wins" rule would let a confident `full` overwrite structural
 * proof of loss and publish a completeness claim the pipeline knows to be
 * false. That is the very failure this signal exists to prevent.
 *
 * So the more pessimistic verdict wins: `partial` and `shell` are falsifiable
 * claims backed by evidence, `full` is the absence of one. Ties go to the
 * browser, whose verdict comes from watching the page rather than inspecting
 * bytes afterwards.
 */
/**
 * Did this capture come back as a SHELL — i.e. the page's content never rendered?
 *
 * Takes the two producers separately and reconciles them with the same pessimistic rule as
 * `mergeCompleteness`, so a caller cannot accidentally consult only the render verdict (which
 * reports `full` as its ordinary outcome) and miss structural proof that extraction lost the
 * body. `partial` is deliberately NOT a shell: it is a real page that lost part of itself.
 */
export function isShellCapture(
  render: { contentCompleteness?: ContentCompleteness },
  extraction: { contentCompleteness?: ContentCompleteness },
): boolean {
  return (
    mergeCompleteness(render.contentCompleteness, extraction.contentCompleteness)?.level === 'shell'
  );
}

export function mergeCompleteness(
  render: ContentCompleteness | undefined,
  extraction: ContentCompleteness | undefined,
): ContentCompleteness | undefined {
  if (!render) return extraction;
  if (!extraction) return render;
  return SEVERITY[extraction.level] > SEVERITY[render.level] ? extraction : render;
}
