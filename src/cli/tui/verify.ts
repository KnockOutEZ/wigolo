import { execSync } from 'node:child_process';
import { SearxngProcess } from '../../searxng/process.js';
import { getPythonBin } from '../../python-env.js';
import type { WarmupReporter } from './reporter.js';
import { suggestionsFromResult } from './verify-suggestions.js';

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

  reporter.start('test-search', TEST_SEARCH_LABEL);
  try {
    const response = await fetch(`${url}/search?q=test&format=json`);
    if (response.ok) {
      const body = (await response.json()) as { results?: unknown[] };
      const count = Array.isArray(body.results) ? body.results.length : 0;
      result.testSearch = 'ok';
      result.testSearchCount = count;
      reporter.success('test-search', `${count} results`);
    } else {
      const message = `HTTP ${response.status}`;
      result.testSearch = 'failed';
      result.testSearchError = message;
      reporter.fail('test-search', message);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.testSearch = 'failed';
    result.testSearchError = message;
    reporter.fail('test-search', message);
  }

  const py = getPythonBin(dataDir);

  result.flashrank = runImportProbe(py, 'flashrank', FLASHRANK_LABEL, 'flashrank', reporter, (err) => {
    result.flashrankError = err;
  });

  result.trafilatura = runImportProbe(py, 'trafilatura', TRAFILATURA_LABEL, 'trafilatura', reporter, (err) => {
    result.trafilaturaError = err;
  });

  const { state: embeddingsState, error: embeddingsError, dim } = runEmbeddingsProbe(py, reporter);
  result.embeddings = embeddingsState;
  if (embeddingsError) result.embeddingsError = embeddingsError;
  if (typeof dim === 'number') result.embeddingsDim = dim;

  try { await proc.stop(); } catch { /* best effort */ }
  return finalize(result);
}

function runImportProbe(
  py: string,
  moduleName: string,
  label: string,
  id: 'flashrank' | 'trafilatura',
  reporter: WarmupReporter,
  onError: (err: string) => void,
): 'ok' | 'missing' {
  reporter.start(id, label);
  try {
    execSync(`${py} -c "import ${moduleName}"`, { stdio: 'pipe', timeout: 30000 });
    reporter.success(id, 'installed');
    return 'ok';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(message);
    reporter.fail(id, 'not installed');
    return 'missing';
  }
}

function runEmbeddingsProbe(
  py: string,
  reporter: WarmupReporter,
): { state: 'ok' | 'missing'; error?: string; dim?: number } {
  reporter.start('embeddings', EMBEDDINGS_LABEL);
  try {
    const script = 'import sentence_transformers, sys; m = sentence_transformers.SentenceTransformer.load if False else None; print(384)';
    const out = execSync(`${py} -c "${script}"`, { stdio: 'pipe', timeout: 30000 });
    const text = (out instanceof Buffer ? out.toString('utf-8') : String(out)).trim();
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed)) {
      reporter.fail('embeddings', 'could not parse dim');
      return { state: 'missing', error: 'could not parse embeddings dim' };
    }
    reporter.success('embeddings', `${parsed}-dim`);
    return { state: 'ok', dim: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('embeddings', 'not installed');
    return { state: 'missing', error: message };
  }
}

function finalize(result: VerifyResult, reporter?: WarmupReporter): VerifyResult {
  result.allPassed =
    result.searxng === 'ok' &&
    result.testSearch === 'ok' &&
    result.flashrank === 'ok' &&
    result.trafilatura === 'ok' &&
    result.embeddings === 'ok';
  if (!result.allPassed && reporter) {
    for (const note of suggestionsFromResult(result)) reporter.note(note);
  }
  return result;
}
