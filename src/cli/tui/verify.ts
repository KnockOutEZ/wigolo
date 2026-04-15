import { execSync } from 'node:child_process';
import { SearxngProcess } from '../../searxng/process.js';
import { getPythonBin } from '../../python-env.js';
import type { WarmupReporter } from './reporter.js';

export interface VerifyResult {
  searxng: 'ok' | 'failed';
  searxngUrl?: string;
  searxngError?: string;
  testSearch: 'ok' | 'failed' | 'skipped';
  testSearchError?: string;
  testSearchCount?: number;
  flashrank: 'ok' | 'missing';
  flashrankError?: string;
  trafilatura: 'ok' | 'missing';
  trafilaturaError?: string;
  embeddings: 'ok' | 'missing';
  embeddingsError?: string;
  embeddingsDim?: number;
  allPassed: boolean;
}

const SEARXNG_LABEL = 'Starting SearXNG';
const TEST_SEARCH_LABEL = 'Running test search';
const FLASHRANK_LABEL = 'Checking FlashRank';
const TRAFILATURA_LABEL = 'Checking Trafilatura';
const EMBEDDINGS_LABEL = 'Checking embeddings';

export async function runVerify(
  dataDir: string,
  reporter: WarmupReporter,
): Promise<VerifyResult> {
  const result: VerifyResult = {
    searxng: 'failed',
    testSearch: 'skipped',
    flashrank: 'missing',
    trafilatura: 'missing',
    embeddings: 'missing',
    allPassed: false,
  };

  const proc = new SearxngProcess(`${dataDir}/searxng`, dataDir);

  reporter.start('searxng', SEARXNG_LABEL);
  let url: string | null = null;
  try {
    url = await proc.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.searxng = 'failed';
    result.searxngError = message;
    reporter.fail('searxng', message);
    try { await proc.stop(); } catch { /* already dead */ }
    return finalize(result);
  }

  if (!url) {
    result.searxng = 'failed';
    result.searxngError = 'did not return a listening URL';
    reporter.fail('searxng', 'did not return a listening URL');
    try { await proc.stop(); } catch { /* already dead */ }
    return finalize(result);
  }

  result.searxng = 'ok';
  result.searxngUrl = url;
  reporter.success('searxng', url);

  void execSync;
  void getPythonBin;
  void TEST_SEARCH_LABEL;
  void FLASHRANK_LABEL;
  void TRAFILATURA_LABEL;
  void EMBEDDINGS_LABEL;

  try { await proc.stop(); } catch { /* best effort */ }
  return finalize(result);
}

function finalize(result: VerifyResult): VerifyResult {
  result.allPassed =
    result.searxng === 'ok' &&
    result.testSearch === 'ok' &&
    result.flashrank === 'ok' &&
    result.trafilatura === 'ok' &&
    result.embeddings === 'ok';
  return result;
}
