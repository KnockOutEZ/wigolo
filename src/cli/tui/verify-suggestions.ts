import type { VerifyResult } from './verify.js';

export type VerifyCheckId =
  | 'searxng'
  | 'test-search'
  | 'flashrank'
  | 'trafilatura'
  | 'embeddings';

const TABLE: Record<VerifyCheckId, string> = {
  'searxng': 'SearXNG failed to start. Try: npx @staticn0va/wigolo warmup --force',
  'test-search': 'Test search failed. Check that SearXNG is healthy: npx @staticn0va/wigolo doctor',
  'flashrank': 'FlashRank is not installed. Run: npx @staticn0va/wigolo warmup',
  'trafilatura': 'Trafilatura is not installed. Run: npx @staticn0va/wigolo warmup',
  'embeddings': 'Embeddings model is not installed. Run: npx @staticn0va/wigolo warmup',
};

export function suggestionFor(id: VerifyCheckId): string {
  return TABLE[id];
}

export function suggestionsFromResult(result: VerifyResult): string[] {
  const out: string[] = [];
  if (result.searxng !== 'ok') out.push(suggestionFor('searxng'));
  if (result.testSearch === 'failed') out.push(suggestionFor('test-search'));
  if (result.flashrank !== 'ok') out.push(suggestionFor('flashrank'));
  if (result.trafilatura !== 'ok') out.push(suggestionFor('trafilatura'));
  if (result.embeddings !== 'ok') out.push(suggestionFor('embeddings'));
  return out;
}
