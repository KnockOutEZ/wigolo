import type { VerifyResult } from './verify.js';

export type VerifyCheckId =
  | 'searxng'
  | 'reranker'
  | 'embeddings';

const TABLE: Record<VerifyCheckId, string> = {
  'searxng': 'Search engine failed to start. Try: npx wigolo warmup --force',
  'reranker': 'ML reranker downloads on first use. Pre-cache: npx wigolo warmup --reranker',
  'embeddings': 'Embeddings model downloads on first use. Pre-cache: npx wigolo warmup --embeddings',
};

export function suggestionFor(id: VerifyCheckId): string {
  return TABLE[id];
}

export function suggestionsFromResult(result: VerifyResult): string[] {
  const out: string[] = [];
  // 'skipped' means the core backend is in use (sidecar opt-in) — that is not a
  // failure, so no fix suggestion is emitted for it.
  if (result.searxng !== 'ok' && result.searxng !== 'skipped') out.push(suggestionFor('searxng'));
  if (result.reranker !== 'ok') out.push(suggestionFor('reranker'));
  if (result.embeddings !== 'ok') out.push(suggestionFor('embeddings'));
  return out;
}
