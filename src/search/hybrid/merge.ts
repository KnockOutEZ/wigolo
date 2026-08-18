import { normalizeUrl } from '../../cache/store.js';
import { normalizeResultUrl } from '../url-unwrap.js';
import {
  buildRankMap,
  reciprocalRankFusion,
  sortByRRFScore,
} from '../rrf.js';
import type {
  EngineOutcomeSummary,
  SearchOutput,
  SearchResultItem,
} from '../../types.js';

const RRF_K = 60;

export interface MergeOptions {
  maxResults?: number;
}

export interface MergeOutcome {
  results: SearchResultItem[];
  engines_used: string[];
  engines_dispatched?: string[];
  engine_outcomes?: EngineOutcomeSummary[];
}

function canonicalKey(url: string): string {
  const unwrapped = normalizeResultUrl(url);
  try {
    return normalizeUrl(unwrapped);
  } catch {
    return unwrapped;
  }
}

function preferred(
  existing: SearchResultItem,
  candidate: SearchResultItem,
): SearchResultItem {
  const existingHasContent =
    typeof existing.markdown_content === 'string' && existing.markdown_content.length > 0;
  const candidateHasContent =
    typeof candidate.markdown_content === 'string' && candidate.markdown_content.length > 0;
  if (existingHasContent !== candidateHasContent) {
    return existingHasContent ? existing : candidate;
  }
  return candidate.relevance_score > existing.relevance_score ? candidate : existing;
}

function collectKeyedResults(
  source: SearchOutput,
  byKey: Map<string, SearchResultItem>,
): string[] {
  const keys: string[] = [];
  for (const r of source.results) {
    const key = canonicalKey(r.url);
    keys.push(key);
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferred(existing, r) : r);
  }
  return keys;
}

export function mergeResults(
  core: SearchOutput,
  searxng: SearchOutput,
  options: MergeOptions = {},
): MergeOutcome {
  const byKey = new Map<string, SearchResultItem>();
  const coreKeys = collectKeyedResults(core, byKey);
  const searxngKeys = collectKeyedResults(searxng, byKey);

  const lists: Map<string, number>[] = [];
  if (coreKeys.length > 0) lists.push(buildRankMap(coreKeys));
  if (searxngKeys.length > 0) lists.push(buildRankMap(searxngKeys));

  const fused = reciprocalRankFusion(lists, RRF_K);
  const sorted = sortByRRFScore(fused);
  const maxScore = sorted[0]?.[1] ?? 0;

  const ordered: SearchResultItem[] = [];
  for (const [key, score] of sorted) {
    const base = byKey.get(key);
    if (!base) continue;
    ordered.push({
      ...base,
      relevance_score: maxScore > 0 ? score / maxScore : base.relevance_score,
    });
  }

  const cap =
    typeof options.maxResults === 'number' && options.maxResults >= 0
      ? options.maxResults
      : ordered.length;
  const results = ordered.slice(0, cap);

  const enginesSet = new Set<string>([
    ...core.engines_used,
    ...searxng.engines_used,
  ]);
  const dispatchedSet = new Set<string>([
    ...(core.engines_dispatched ?? []),
    ...(searxng.engines_dispatched ?? []),
  ]);

  const merged: MergeOutcome = {
    results,
    engines_used: [...enginesSet],
  };

  if (dispatchedSet.size > 0) {
    merged.engines_dispatched = [...dispatchedSet];
  }

  if (core.engine_outcomes || searxng.engine_outcomes) {
    merged.engine_outcomes = [
      ...(core.engine_outcomes ?? []),
      ...(searxng.engine_outcomes ?? []),
    ];
  }

  return merged;
}
