import { detectAll } from 'tinyld';
import { createLogger } from '../logger.js';

const MIN_DETECT_CHARS = 12;
const MIN_CONFIDENCE = 0.1;

// Languages that use Latin script — used to avoid false positives when target is Latin.
const LATIN_LANGS = new Set([
  'en', 'es', 'fr', 'pt', 'de', 'it', 'nl', 'da', 'sv', 'no', 'fi', 'is',
  'pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'lt', 'lv', 'et', 'tr', 'vi',
  'id', 'ms', 'tl', 'sw', 'af', 'ca', 'gl', 'eu', 'ga', 'cy', 'mt', 'sq',
  'lb', 'fo', 'ber', 'so', 'ha', 'yo', 'ig', 'zu', 'xh', 'st', 'tn',
]);

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

function detectLang(text: string): string {
  const t = text?.trim() ?? '';
  if (t.length < MIN_DETECT_CHARS) return 'und';
  try {
    const ranked = detectAll(t);
    const top = ranked[0];
    if (!top || top.accuracy < MIN_CONFIDENCE) return 'und';
    return top.lang || 'und';
  } catch {
    return 'und';
  }
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

  const targetIsLatin = LATIN_LANGS.has(opts.target);
  const isMismatch = (lang: string): boolean => {
    if (lang === opts.target || lang === 'und') return false;
    // Script-aware: Latin-target vs Latin-detected is treated as a match
    // because tinyld misclassifies short Latin-script text into other Latin
    // languages with low confidence.
    if (targetIsLatin && LATIN_LANGS.has(lang)) return false;
    return true;
  };

  const kept: T[] = [];
  for (const [engine, batch] of byEngine) {
    let nonTarget = 0;
    const langs = batch.map(r => detectLang(`${r.title} ${r.snippet}`));
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
