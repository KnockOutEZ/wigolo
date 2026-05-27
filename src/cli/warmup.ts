import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { getRerankProvider } from '../providers/rerank-provider.js';
import { runCommand } from './tui/run-command.js';
import type { WarmupReporter } from './tui/reporter.js';
import { autoReporter } from './tui/reporter-auto.js';
import { runVerify as runVerifyTui } from './tui/verify.js';

export interface WarmupResult {
  playwright: 'ok' | 'failed';
  playwrightError?: string;
  searxng: 'ready' | 'bootstrapped' | 'failed' | 'no_python';
  searxngError?: string;
  reranker?: 'ok' | 'failed';
  rerankerError?: string;
  firefox?: 'ok' | 'failed';
  firefoxError?: string;
  webkit?: 'ok' | 'failed';
  webkitError?: string;
  embeddings?: 'ok' | 'failed';
  embeddingsError?: string;
}

function wipeSearxngState(dataDir: string, reporter: WarmupReporter): void {
  const bootstrapLockPath = join(dataDir, 'bootstrap.lock');
  if (existsSync(bootstrapLockPath)) {
    try {
      const lock = JSON.parse(readFileSync(bootstrapLockPath, 'utf-8')) as { pid?: number };
      if (lock.pid && isProcessAlive(lock.pid)) {
        throw new Error(
          `Cannot --force: another wigolo bootstrap is in progress (pid ${lock.pid}). ` +
          `Kill it first: kill ${lock.pid}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Cannot --force')) throw err;
    }
  }
  rmSync(join(dataDir, 'state.json'), { force: true });
  rmSync(join(dataDir, 'searxng'), { recursive: true, force: true });
  rmSync(bootstrapLockPath, { force: true });
  rmSync(join(dataDir, 'searxng.lock'), { force: true });
  rmSync(join(dataDir, 'searxng.port'), { force: true });
  reporter.note('Wiped search engine state, install, and locks (--force)');
}

async function installPlaywright(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'playwright' | 'playwrightError'>> {
  reporter.start('playwright', 'Installing browser engine (chromium)');
  const r = await runCommand('npx', ['playwright', 'install', 'chromium'], { timeout: 180000 });
  if (r.code === 0) {
    reporter.success('playwright', 'installed');
    return { playwright: 'ok' };
  }
  const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
  reporter.fail('playwright', message);
  return { playwright: 'failed', playwrightError: message };
}

async function installReranker(
  reporter: WarmupReporter,
): Promise<Pick<WarmupResult, 'reranker' | 'rerankerError'>> {
  reporter.start('reranker', 'Downloading ML reranker model (cross-encoder)');
  try {
    const provider = await getRerankProvider();
    // Smoke-test end-to-end: warmup loads model + tokenizer, then a single
    // rerank call exercises the inference path.
    const scored = await provider.rerank('warmup', [
      { id: '0', text: 'hello world' },
    ]);
    if (scored.length !== 1) {
      throw new Error(`unexpected rerank shape (results=${scored.length})`);
    }
    reporter.success('reranker', `model ${provider.modelId} ready`);
    return { reranker: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('reranker', message);
    return { reranker: 'failed', rerankerError: message };
  }
}

async function installFirefox(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'firefox' | 'firefoxError'>> {
  reporter.start('firefox', 'Installing browser engine (firefox)');
  const r = await runCommand('npx', ['playwright', 'install', 'firefox'], { timeout: 180000 });
  if (r.code === 0) {
    reporter.success('firefox', 'installed');
    return { firefox: 'ok' };
  }
  const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
  reporter.fail('firefox', message);
  return { firefox: 'failed', firefoxError: message };
}

async function installWebkit(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'webkit' | 'webkitError'>> {
  reporter.start('webkit', 'Installing browser engine (webkit)');
  const r = await runCommand('npx', ['playwright', 'install', 'webkit'], { timeout: 180000 });
  if (r.code === 0) {
    reporter.success('webkit', 'installed');
    return { webkit: 'ok' };
  }
  const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
  reporter.fail('webkit', message);
  return { webkit: 'failed', webkitError: message };
}

async function installEmbeddings(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'embeddings' | 'embeddingsError'>> {
  reporter.start('embeddings', 'Downloading semantic embeddings model (fastembed)');
  try {
    const { FastembedEmbedProvider } = await import('../embedding/fastembed-provider.js');
    const provider = new FastembedEmbedProvider();
    await provider.warmup();
    // Probe to ensure the ONNX model can actually produce a vector end-to-end.
    const [vec] = await provider.embed(['warmup']);
    if (!vec || vec.length !== provider.dim) {
      throw new Error(`unexpected embedding shape (dim=${vec?.length ?? 'undef'})`);
    }
    reporter.success('embeddings', `model ${provider.modelId} ready`);
    return { embeddings: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('embeddings', message);
    return { embeddings: 'failed', embeddingsError: message };
  }
}

async function runSearxngPhase(dataDir: string, reporter: WarmupReporter): Promise<Pick<WarmupResult, 'searxng' | 'searxngError'>> {
  const state = getBootstrapState(dataDir);
  if (state?.status === 'ready') {
    reporter.start('searxng', 'Checking search engine (searxng)');
    reporter.success('searxng', 'already set up');
    return { searxng: 'ready' };
  }

  if (!checkPythonAvailable()) {
    reporter.start('searxng', 'Checking search engine (searxng)');
    reporter.fail('searxng', 'Python 3 not found — install Python 3 or set SEARXNG_MODE=docker');
    return { searxng: 'no_python' };
  }

  reporter.start('searxng', 'Bootstrapping search engine (searxng) — this may take a minute');
  try {
    await bootstrapNativeSearxng(dataDir);
    reporter.success('searxng', 'bootstrapped');
    return { searxng: 'bootstrapped' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('searxng', message);
    return { searxng: 'failed', searxngError: message };
  }
}

async function runVerify(dataDir: string, reporter: WarmupReporter): Promise<void> {
  reporter.note('');
  reporter.note('Verifying setup...');
  await runVerifyTui(dataDir, reporter);
  reporter.note('');
  reporter.note('✓ Done. Connect to your AI tool:');
  reporter.note('  claude mcp add wigolo -- npx @staticn0va/wigolo');
}

export async function runWarmup(
  flags: string[] = [],
  reporter?: WarmupReporter,
): Promise<WarmupResult> {
  const flagSet = new Set(flags);
  const plain = flagSet.has('--plain');
  const reporterImpl = reporter ?? autoReporter({ plain });

  const config = getConfig();

  if (flagSet.has('--force')) {
    wipeSearxngState(config.dataDir, reporterImpl);
  }

  reporterImpl.note('Starting wigolo warmup');

  const pwResult = await installPlaywright(reporterImpl);
  const searxngResult = await runSearxngPhase(config.dataDir, reporterImpl);

  let rerankerResult: Pick<WarmupResult, 'reranker' | 'rerankerError'> = {};
  if (flagSet.has('--reranker') || flagSet.has('--all')) {
    rerankerResult = await installReranker(reporterImpl);
  }

  let firefoxResult: Pick<WarmupResult, 'firefox' | 'firefoxError'> = {};
  if (flagSet.has('--firefox') || flagSet.has('--all')) {
    firefoxResult = await installFirefox(reporterImpl);
  }

  let webkitResult: Pick<WarmupResult, 'webkit' | 'webkitError'> = {};
  if (flagSet.has('--webkit') || flagSet.has('--all')) {
    webkitResult = await installWebkit(reporterImpl);
  }

  let embeddingsResult: Pick<WarmupResult, 'embeddings' | 'embeddingsError'> = {};
  if (flagSet.has('--embeddings') || flagSet.has('--all')) {
    embeddingsResult = await installEmbeddings(reporterImpl);
  }

  const result: WarmupResult = {
    ...pwResult,
    ...searxngResult,
    ...rerankerResult,
    ...firefoxResult,
    ...webkitResult,
    ...embeddingsResult,
  };

  reporterImpl.note('');
  reporterImpl.note('Summary:');
  reporterImpl.note(`  Browser:       ${result.playwright}${result.playwrightError ? ` (${result.playwrightError})` : ''}`);
  reporterImpl.note(`  Search engine: ${result.searxng}${result.searxngError ? ` (${result.searxngError})` : ''}`);
  if (result.reranker) reporterImpl.note(`  ML reranker:   ${result.reranker}${result.rerankerError ? ` (${result.rerankerError})` : ''}`);
  if (result.firefox) reporterImpl.note(`  Firefox:       ${result.firefox}${result.firefoxError ? ` (${result.firefoxError})` : ''}`);
  if (result.webkit) reporterImpl.note(`  WebKit:        ${result.webkit}${result.webkitError ? ` (${result.webkitError})` : ''}`);
  if (result.embeddings) reporterImpl.note(`  Embeddings:    ${result.embeddings}${result.embeddingsError ? ` (${result.embeddingsError})` : ''}`);

  if (flagSet.has('--verify') || flagSet.has('--all')) {
    await runVerify(config.dataDir, reporterImpl);
  }

  reporterImpl.finish();
  return result;
}
