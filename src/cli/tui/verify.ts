import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SearxngProcess } from '../../searxng/process.js';
import { getRerankProvider } from '../../providers/rerank-provider.js';
import type { WarmupReporter } from './reporter.js';
import { suggestionsFromResult } from './verify-suggestions.js';

export interface VerifyResult {
  searxng: 'ok' | 'failed';
  searxngUrl?: string;
  searxngError?: string;
  reranker: 'ok' | 'missing';
  rerankerError?: string;
  embeddings: 'ok' | 'missing';
  embeddingsError?: string;
  embeddingsDim?: number;
  allPassed: boolean;
}

const SEARXNG_LABEL = 'Starting search engine (searxng)';
const RERANKER_LABEL = 'Checking ML reranker (cross-encoder)';
const EMBEDDINGS_LABEL = 'Checking embeddings';

export async function runVerify(
  dataDir: string,
  reporter: WarmupReporter,
): Promise<VerifyResult> {
  const result: VerifyResult = {
    searxng: 'failed',
    reranker: 'missing',
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
    return finalize(result, reporter);
  }

  if (!url) {
    result.searxng = 'failed';
    result.searxngError = 'did not return a listening URL';
    reporter.fail('searxng', 'did not return a listening URL');
    try { await proc.stop(); } catch { /* already dead */ }
    return finalize(result, reporter);
  }

  result.searxng = 'ok';
  result.searxngUrl = url;
  reporter.success('searxng', url);

  const rerankerProbe = await runRerankerProbe(reporter);
  result.reranker = rerankerProbe.state;
  if (rerankerProbe.error) result.rerankerError = rerankerProbe.error;

  const { state: embeddingsState, error: embeddingsError, dim } = runEmbeddingsProbe(dataDir, reporter);
  result.embeddings = embeddingsState;
  if (embeddingsError) result.embeddingsError = embeddingsError;
  if (typeof dim === 'number') result.embeddingsDim = dim;

  try { await proc.stop(); } catch { /* best effort */ }
  return finalize(result);
}

async function runRerankerProbe(
  reporter: WarmupReporter,
): Promise<{ state: 'ok' | 'missing'; error?: string }> {
  reporter.start('reranker', RERANKER_LABEL);
  try {
    const provider = await getRerankProvider();
    await provider.rerank('warmup', [{ id: '0', text: 'hello world' }]);
    reporter.success('reranker', `installed (${provider.modelId})`);
    return { state: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('reranker', 'not installed');
    return { state: 'missing', error: message };
  }
}

function runEmbeddingsProbe(
  dataDir: string,
  reporter: WarmupReporter,
): { state: 'ok' | 'missing'; error?: string; dim?: number } {
  reporter.start('embeddings', EMBEDDINGS_LABEL);
  const fastembedDir = join(dataDir, 'fastembed');
  try {
    if (!existsSync(fastembedDir) || readdirSync(fastembedDir).length === 0) {
      reporter.fail('embeddings', 'not installed');
      return { state: 'missing', error: 'fastembed model directory is empty or missing' };
    }
    reporter.success('embeddings', 'installed');
    return { state: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('embeddings', 'not installed');
    return { state: 'missing', error: message };
  }
}

function finalize(result: VerifyResult, reporter?: WarmupReporter): VerifyResult {
  result.allPassed =
    result.searxng === 'ok' &&
    result.reranker === 'ok' &&
    result.embeddings === 'ok';
  if (!result.allPassed && reporter) {
    for (const note of suggestionsFromResult(result)) reporter.note(note);
  }
  return result;
}
