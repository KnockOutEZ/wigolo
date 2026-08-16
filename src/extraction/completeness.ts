import { parseHTML } from 'linkedom';
import type { ContentCompleteness } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('extract');

/**
 * Minimum titled rows before the ratio is allowed to decide anything.
 *
 * The floor is what keeps the gate honest: at N = 5 the finest ratio step is
 * 1/5 = 0.2, comfortably coarser than the 0.5 threshold, so firing always
 * means "at least 3 of 5 titles are genuinely gone" and never degenerates into
 * a secret "zero survived" test. Below the floor a listing is short enough
 * that a single row swings the ratio past the threshold, so we refuse to judge.
 */
const MIN_TITLED_ROWS = 5;

/** Fire when at most half the titles that existed in the source survive. */
const SURVIVING_TITLE_RATIO = 0.5;

/**
 * Fraction of a title's distinctive tokens that must appear in the output
 * before the title counts as surviving. Below 1.0 so a title the extractor
 * kept but reflowed (an inline link splitting it, a badge glued on) still
 * reads as present — the error direction here is deliberately "assume it
 * survived", because a false silence is far cheaper than a false alarm.
 */
const TITLE_TOKEN_COVERAGE = 0.6;

/** Rows must still be visible in the output for their absence to be *silent*. */
const SURVIVING_ROW_RATIO = 0.5;

const LIST_ROW_SELECTOR = 'li, [role="listitem"]';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const BULLET_LINE = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+\S/gm;

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
 * The residue condition (rows still visible in the output) is the part that
 * separates real harm from correct behaviour. An extractor that drops a
 * related-links block wholesale leaves nothing behind and misleads nobody; an
 * extractor that keeps twelve rows and throws away eleven titles hands the
 * caller something that *looks* complete. Only the second case fires.
 *
 * Returns `undefined` when the page is fine — callers omit the field entirely
 * rather than emitting a "full" claim this predicate is not entitled to make.
 */
export function assessListTitleAttrition(
  sourceHtml: string,
  markdown: string,
): ContentCompleteness | undefined {
  if (!sourceHtml || !markdown) return undefined;

  // Cheap pre-filter so the common article/docs page never pays for a parse.
  // Firing needs MIN_TITLED_ROWS titled rows AND at least half of them still
  // visible as bullets, so fewer than that many bullets can never fire.
  const rowsInOutput = (markdown.match(BULLET_LINE) ?? []).length;
  if (rowsInOutput < Math.ceil(MIN_TITLED_ROWS * SURVIVING_ROW_RATIO)) return undefined;

  let titles: string[][];
  try {
    const { document } = parseHTML(sourceHtml);
    const rows = new Set(document.querySelectorAll(LIST_ROW_SELECTOR));
    titles = [];
    for (const row of rows) {
      const heading = row.querySelector(HEADING_SELECTOR);
      if (!heading) continue;
      const tokens = uniqueTokens(heading.textContent ?? '');
      // A one-token heading ("Bug:", "Docs") carries too little signal to tell
      // survival from coincidence, so it never joins the denominator.
      if (tokens.length < 2) continue;
      titles.push(tokens);
    }
  } catch (err) {
    log.debug('completeness assessment skipped — parse failed', { error: String(err) });
    return undefined;
  }

  const titledRows = titles.length;
  if (titledRows < MIN_TITLED_ROWS) return undefined;

  // Structure gone too? Then the output is honestly short, not deceptively
  // complete. Not our case.
  if (rowsInOutput < titledRows * SURVIVING_ROW_RATIO) return undefined;

  const outputTokens = new Set(tokenize(markdown));
  const survivingTitles = titles.filter((tokens) => {
    const present = tokens.filter((t) => outputTokens.has(t)).length;
    return present / tokens.length >= TITLE_TOKEN_COVERAGE;
  }).length;

  if (survivingTitles > titledRows * SURVIVING_TITLE_RATIO) return undefined;

  log.debug('list title attrition detected', {
    titledRows,
    survivingTitles,
    rowsInOutput,
  });

  return { level: 'partial', reason: 'list_titles_dropped', settled_by: 'extraction' };
}
