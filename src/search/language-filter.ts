import { createLogger } from '../logger.js';

const MIN_DETECT_CHARS = 12;

/**
 * A non-Latin script wins the document even from a minority of its letters:
 * a Chinese or Russian result routinely carries a Latin brand name, a product
 * code or a URL fragment in its title.
 */
const NON_LATIN_SHARE = 0.2;

// Languages that use Latin script — used to avoid false positives when target is Latin.
const LATIN_LANGS = new Set([
  'en', 'es', 'fr', 'pt', 'de', 'it', 'nl', 'da', 'sv', 'no', 'fi', 'is',
  'pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'lt', 'lv', 'et', 'tr', 'vi',
  'id', 'ms', 'tl', 'sw', 'af', 'ca', 'gl', 'eu', 'ga', 'cy', 'mt', 'sq',
  'lb', 'fo', 'ber', 'so', 'ha', 'yo', 'ig', 'zu', 'xh', 'st', 'tn',
]);

/**
 * Language detection here is SCRIPT detection, deliberately.
 *
 * This filter never used more than script separation in practice. `isMismatch`
 * has always treated every Latin-script language as a match whenever the target
 * is Latin — the comment below records why, short Latin-script snippets get
 * misclassified between Latin languages — and the target defaults to 'en'. So on
 * the default path the only decision that ever fired was "is this result in a
 * different script from the one I asked for".
 *
 * That decision does not need a 12 MB n-gram model. It needs Unicode ranges.
 * Comparing script FAMILIES rather than language codes also removes a sharp edge
 * the old code had: with target='uk', a full-recall language model would drop
 * every Russian-script neighbour, and misdetection between close Cyrillic
 * languages would drop correct results too.
 *
 * What is genuinely given up: telling apart languages that SHARE a script
 * (ru/uk/bg/sr, hi/mr/ne, zh/ja mixed text). Those results are now kept rather
 * than dropped. The filter is a spam/wrong-locale guard, so keeping a
 * same-script neighbour is the benign direction to be wrong in.
 */
type Script =
  | 'latin' | 'cyrillic' | 'greek' | 'hebrew' | 'arabic' | 'devanagari'
  | 'han' | 'hangul' | 'thai' | 'bengali' | 'tamil' | 'telugu' | 'kannada'
  | 'malayalam' | 'gujarati' | 'gurmukhi' | 'sinhala' | 'myanmar' | 'khmer'
  | 'lao' | 'georgian' | 'armenian' | 'ethiopic' | 'und';

const SCRIPT_PATTERNS: ReadonlyArray<readonly [Exclude<Script, 'und'>, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  // Japanese kana sit with Han: mixed Japanese text must not split its own vote.
  ['han', /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['thai', /\p{Script=Thai}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['kannada', /\p{Script=Kannada}/u],
  ['malayalam', /\p{Script=Malayalam}/u],
  ['gujarati', /\p{Script=Gujarati}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u],
  ['sinhala', /\p{Script=Sinhala}/u],
  ['myanmar', /\p{Script=Myanmar}/u],
  ['khmer', /\p{Script=Khmer}/u],
  ['lao', /\p{Script=Lao}/u],
  ['georgian', /\p{Script=Georgian}/u],
  ['armenian', /\p{Script=Armenian}/u],
  ['ethiopic', /\p{Script=Ethiopic}/u],
];

/** ISO-639-1 -> script, for the non-Latin languages a caller may target. */
const LANG_SCRIPT: Record<string, Exclude<Script, 'und'>> = {
  ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic', mk: 'cyrillic',
  be: 'cyrillic', kk: 'cyrillic', ky: 'cyrillic', mn: 'cyrillic', tg: 'cyrillic',
  el: 'greek',
  he: 'hebrew', iw: 'hebrew', yi: 'hebrew',
  ar: 'arabic', fa: 'arabic', ur: 'arabic', ps: 'arabic', sd: 'arabic', ug: 'arabic',
  hi: 'devanagari', mr: 'devanagari', ne: 'devanagari', sa: 'devanagari',
  zh: 'han', ja: 'han', yue: 'han',
  ko: 'hangul',
  th: 'thai',
  bn: 'bengali', as: 'bengali',
  ta: 'tamil', te: 'telugu', kn: 'kannada', ml: 'malayalam',
  gu: 'gujarati', pa: 'gurmukhi', si: 'sinhala',
  my: 'myanmar', km: 'khmer', lo: 'lao',
  ka: 'georgian', hy: 'armenian', am: 'ethiopic', ti: 'ethiopic',
};

function scriptOfLanguage(code: string): Script {
  if (LATIN_LANGS.has(code)) return 'latin';
  return LANG_SCRIPT[code] ?? 'und';
}

const log = createLogger('language-filter');

export interface RawSearchResult {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  [k: string]: unknown;
}

export interface DiscardedResult<T extends RawLike = RawSearchResult> {
  result: T;
  reason: 'invalid_url' | 'language_mismatch' | 'engine_batch_dropped';
}

export interface FilterOptions {
  target: string;            // ISO-639 code, e.g. 'en'
  dropThreshold: number;     // fraction of batch non-target before drop, e.g. 0.4
}

export interface FilterResult<T extends RawLike = RawSearchResult> {
  results: T[];
  discarded: DiscardedResult<T>[];
  warnings: string[];
}

interface RawLike {
  url: string;
  title: string;
  snippet: string;
  engine: string;
}

function isValidUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function detectScript(text: string): Script {
  const t = text?.trim() ?? '';
  if (t.length < MIN_DETECT_CHARS) return 'und';

  const counts = new Map<Exclude<Script, 'und'>, number>();
  let letters = 0;
  for (const ch of t) {
    for (const [script, pattern] of SCRIPT_PATTERNS) {
      if (pattern.test(ch)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        letters += 1;
        break;
      }
    }
  }
  if (letters === 0) return 'und';

  let best: Exclude<Script, 'und'> | null = null;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (script === 'latin') continue;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  if (best && bestCount / letters >= NON_LATIN_SHARE) return best;
  return counts.has('latin') ? 'latin' : (best ?? 'und');
}

export function filterByLanguage<T extends RawLike>(
  results: T[],
  opts: FilterOptions,
): FilterResult<T> {
  const discarded: DiscardedResult<T>[] = [];
  const warnings: string[] = [];

  // Step 1: drop invalid URLs first
  const urlValid: T[] = [];
  for (const r of results) {
    if (!isValidUrl(r.url)) {
      discarded.push({ result: r, reason: 'invalid_url' });
      continue;
    }
    urlValid.push(r);
  }

  if (urlValid.length === 0) return { results: [], discarded, warnings };

  // Step 2: per-engine batch language check
  const byEngine = new Map<string, T[]>();
  for (const r of urlValid) {
    const arr = byEngine.get(r.engine) ?? [];
    arr.push(r);
    byEngine.set(r.engine, arr);
  }

  const targetScript = scriptOfLanguage(opts.target);
  const isMismatch = (script: Script): boolean => {
    // 'und' on either side means we could not tell — never drop on that.
    if (script === 'und' || targetScript === 'und') return false;
    return script !== targetScript;
  };

  const kept: T[] = [];
  for (const [engine, batch] of byEngine) {
    let nonTarget = 0;
    const langs = batch.map(r => detectScript(`${r.title} ${r.snippet}`));
    for (const l of langs) if (isMismatch(l)) nonTarget += 1;
    const ratio = nonTarget / batch.length;

    if (ratio > opts.dropThreshold) {
      warnings.push(
        `engine_language_mismatch: ${engine} returned ${Math.round(ratio * 100)}% non-${opts.target}; batch dropped`,
      );
      for (const r of batch) discarded.push({ result: r, reason: 'engine_batch_dropped' });
      log.warn('dropped engine batch for language mismatch', { engine, ratio });
      continue;
    }

    // Drop individual non-target results inside an otherwise-fine batch
    for (let i = 0; i < batch.length; i += 1) {
      if (isMismatch(langs[i])) {
        discarded.push({ result: batch[i], reason: 'language_mismatch' });
      } else {
        kept.push(batch[i]);
      }
    }
  }

  return { results: kept, discarded, warnings };
}

// Apply filterByLanguage but recover when the filter empties a non-empty raw
// set. Two-step recovery:
//   1. Retry with dropThreshold disabled (batch-drop turned off) so individual
//      target-language hits inside noisy batches survive instead of being
//      collateral damage. Preserves the integration-test invariant that one
//      English result among three Chinese ones still surfaces.
//   2. If still empty, return the URL-valid raw set with a relaxed warning —
//      this covers the May-24 bench failure mode where every engine batch was
//      non-target (e.g. news verticals returning only foreign-language hits).
export function filterByLanguageWithFallback<T extends RawLike>(
  results: T[],
  opts: FilterOptions,
): FilterResult<T> {
  if (results.length === 0) {
    return filterByLanguage(results, opts);
  }
  const filtered = filterByLanguage(results, opts);
  if (filtered.results.length > 0) return filtered;

  // Recovery step 1: disable batch drop, keep per-result lang filter.
  const perResult = filterByLanguage(results, { ...opts, dropThreshold: 1.0 });
  if (perResult.results.length > 0) {
    return {
      results: perResult.results,
      discarded: perResult.discarded,
      warnings: [
        ...filtered.warnings,
        `language_filter_relaxed: strict batch drop emptied results; ` +
          `falling back to per-result lang filter with target=${opts.target}.`,
      ],
    };
  }

  // Recovery step 2: every result is non-target. Surface the raw set with a
  // warning so the caller can communicate the relaxation explicitly.
  const urlValid = results.filter((r) => isValidUrl(r.url));
  if (urlValid.length === 0) return filtered;

  return {
    results: urlValid,
    discarded: filtered.discarded.filter((d) => d.reason === 'invalid_url'),
    warnings: [
      ...filtered.warnings,
      `language_filter_relaxed: every engine batch failed the language check for target=${opts.target}; ` +
        `returning ${urlValid.length} unfiltered result(s) to avoid an empty response. ` +
        `Pass an explicit language= or refine the query if results look wrong.`,
    ],
  };
}
