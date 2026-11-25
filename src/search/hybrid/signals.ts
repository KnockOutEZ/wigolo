import type { SearchInput, SearchOutput } from '../../types.js';
import { COMMON_NOUNS } from './common-nouns.js';

export interface SignalResult {
  fires: boolean;
  reason: string;
}

const TOKEN_RE = /[a-z0-9]+/g;
const OVERLAP_THRESHOLD = 0.3;

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length >= 2);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function primaryHostnameLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host.split('.')[0] ?? '';
  } catch {
    return '';
  }
}

function primaryQuery(input: SearchInput): string {
  if (Array.isArray(input.query)) return (input.query[0] ?? '').trim();
  return (input.query ?? '').trim();
}

export function isBrandCollisionSuspect(
  input: SearchInput,
  output: SearchOutput,
): SignalResult {
  const q = primaryQuery(input);
  const qTokens = tokenize(q);
  if (qTokens.length === 0 || qTokens.length > 2) {
    return { fires: false, reason: '' };
  }
  const matchedNoun = qTokens.find((t) => COMMON_NOUNS.has(t));
  if (!matchedNoun) return { fires: false, reason: '' };
  const top = output.results[0];
  if (!top) return { fires: false, reason: '' };
  const label = primaryHostnameLabel(top.url);
  if (!qTokens.includes(label)) return { fires: false, reason: '' };
  const overlap = jaccard(qTokens, tokenize(top.title));
  if (overlap >= OVERLAP_THRESHOLD) return { fires: false, reason: '' };
  return {
    fires: true,
    reason: `query "${q}" is a common noun, top-1 hostname "${label}" matches the query, title overlap ${(overlap * 100).toFixed(0)}%`,
  };
}

export function isIncludeDomainsOverFilter(
  input: SearchInput,
  output: SearchOutput,
): SignalResult {
  if (!input.include_domains || input.include_domains.length === 0) {
    return { fires: false, reason: '' };
  }
  if (output.results.length >= 2) return { fires: false, reason: '' };
  return {
    fires: true,
    reason: `include_domains set but only ${output.results.length} core result(s)`,
  };
}

export function isAllEnginesFailed(
  _input: SearchInput,
  output: SearchOutput,
): SignalResult {
  if (output.results.length > 0) return { fires: false, reason: '' };
  const outcomes = output.engine_outcomes;
  if (outcomes && outcomes.length > 0 && outcomes.some((o) => o.ok)) {
    return { fires: false, reason: '' };
  }
  return { fires: true, reason: 'core returned no results; engines failed or empty' };
}

const DEGRADED_LOW_LEXICAL_MAX_RESULTS = 1;
const DEGRADED_LOW_LEXICAL_SCORE = 0.4;

export function isDegradedPoolLowLexical(
  _input: SearchInput,
  output: SearchOutput,
): SignalResult {
  const pool = output.engine_pool;
  const collapsed =
    pool?.degraded === true &&
    (pool.reasons?.includes('pool_collapsed') === true ||
      pool.reasons?.includes('no_lexical_match') === true);
  if (!collapsed) return { fires: false, reason: '' };
  if (output.results.length === 0) {
    return {
      fires: true,
      reason: 'engine pool collapsed and core returned no results',
    };
  }
  if (output.results.length > DEGRADED_LOW_LEXICAL_MAX_RESULTS) {
    return { fires: false, reason: '' };
  }
  const top = output.results[0];
  const lex = top.evidence_score?.components.lexical_alignment;
  const weak =
    top.relevance_score < DEGRADED_LOW_LEXICAL_SCORE ||
    (typeof lex === 'number' && lex < DEGRADED_LOW_LEXICAL_SCORE);
  if (!weak) return { fires: false, reason: '' };
  return {
    fires: true,
    reason: `engine pool collapsed to ${output.results.length} low-confidence result(s)`,
  };
}

export function isTop1HighScoreLowOverlap(
  input: SearchInput,
  output: SearchOutput,
): SignalResult {
  const top = output.results[0];
  if (!top) return { fires: false, reason: '' };
  if (top.relevance_score < 0.99) return { fires: false, reason: '' };
  const q = primaryQuery(input);
  const overlap = jaccard(tokenize(q), tokenize(top.title));
  if (overlap >= OVERLAP_THRESHOLD) return { fires: false, reason: '' };
  return {
    fires: true,
    reason: `top-1 score ${top.relevance_score.toFixed(2)} but title overlap ${(overlap * 100).toFixed(0)}%`,
  };
}

interface NamedSignal {
  name: string;
  predicate: (input: SearchInput, output: SearchOutput) => SignalResult;
}

const SIGNALS: readonly NamedSignal[] = [
  { name: 'brand_collision_suspect', predicate: isBrandCollisionSuspect },
  { name: 'include_domains_over_filter', predicate: isIncludeDomainsOverFilter },
  { name: 'all_engines_failed', predicate: isAllEnginesFailed },
  { name: 'top1_high_score_low_overlap', predicate: isTop1HighScoreLowOverlap },
  { name: 'degraded_pool_low_lexical', predicate: isDegradedPoolLowLexical },
];

export const SIGNAL_NAMES: readonly string[] = SIGNALS.map((s) => s.name);

export function evaluateSignals(input: SearchInput, output: SearchOutput): string[] {
  const fired: string[] = [];
  for (const s of SIGNALS) {
    if (s.predicate(input, output).fires) fired.push(s.name);
  }
  return fired;
}

export function describeSignals(
  input: SearchInput,
  output: SearchOutput,
): { name: string; result: SignalResult }[] {
  return SIGNALS.map((s) => ({ name: s.name, result: s.predicate(input, output) }));
}
