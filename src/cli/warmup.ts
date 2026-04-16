import { existsSync, readFileSync, rmSync, mkdirSync, createWriteStream, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { resetAvailabilityCache } from '../search/flashrank.js';
import { getPythonBin } from '../python-env.js';
import { runCommand } from './tui/run-command.js';
import type { WarmupReporter } from './tui/reporter.js';
import { autoReporter } from './tui/reporter-auto.js';
import { runVerify as runVerifyTui } from './tui/verify.js';

export interface WarmupResult {
  playwright: 'ok' | 'failed';
  playwrightError?: string;
  searxng: 'ready' | 'bootstrapped' | 'failed' | 'no_python';
  searxngError?: string;
  trafilatura?: 'ok' | 'failed' | 'skipped';
  reranker?: 'ok' | 'failed';
  rerankerError?: string;
  firefox?: 'ok' | 'failed';
  firefoxError?: string;
  webkit?: 'ok' | 'failed';
  webkitError?: string;
  embeddings?: 'ok' | 'failed';
  embeddingsError?: string;
  lightpanda?: 'ok' | 'failed';
  lightpandaError?: string;
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
  reporter.note('Wiped SearXNG state, install, and locks (--force)');
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

async function installTrafilatura(dataDir: string, reporter: WarmupReporter): Promise<'ok' | 'failed'> {
  reporter.start('trafilatura', 'Installing content extractor (trafilatura)');
  const py = getPythonBin(dataDir);
  const r = await runCommand(py, ['-m', 'pip', 'install', '--quiet', 'trafilatura'], { timeout: 180000 });
  if (r.code === 0) {
    reporter.success('trafilatura', 'installed');
    return 'ok';
  }
  const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
  reporter.fail('trafilatura', message);
  return 'failed';
}

async function installFlashRank(dataDir: string, reporter: WarmupReporter): Promise<Pick<WarmupResult, 'reranker' | 'rerankerError'>> {
  reporter.start('flashrank', 'Installing ML reranker (flashrank)');
  const py = getPythonBin(dataDir);
  const r = await runCommand(py, ['-m', 'pip', 'install', '--quiet', 'flashrank'], { timeout: 180000 });
  if (r.code === 0) {
    resetAvailabilityCache();
    reporter.success('flashrank', 'installed');
    return { reranker: 'ok' };
  }
  const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
  reporter.fail('flashrank', message);
  return { reranker: 'failed', rerankerError: message };
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

async function installSentenceTransformers(dataDir: string, reporter: WarmupReporter): Promise<Pick<WarmupResult, 'embeddings' | 'embeddingsError'>> {
  reporter.start('embeddings', 'Installing semantic embeddings (sentence-transformers)');
  const py = getPythonBin(dataDir);
  const r = await runCommand(py, ['-m', 'pip', 'install', '--quiet', 'sentence-transformers'], { timeout: 300000 });
  if (r.code === 0) {
    reporter.success('embeddings', 'installed');
    return { embeddings: 'ok' };
  }
  const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
  reporter.fail('embeddings', message);
  return { embeddings: 'failed', embeddingsError: message };
}

function getLightpandaUrl(): string {
  const platform = process.platform;
  const arch = process.arch;
  const base = 'https://github.com/lightpanda-io/browser/releases/download/nightly';
  if (platform === 'darwin' && arch === 'arm64') return `${base}/lightpanda-aarch64-macos`;
  if (platform === 'linux' && arch === 'x64') return `${base}/lightpanda-x86_64-linux`;
  throw new Error(`Lightpanda not available for ${platform}/${arch}`);
}

async function installLightpanda(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'lightpanda' | 'lightpandaError'>> {
  try {
    const config = getConfig();
    const binDir = join(config.dataDir, 'bin');
    const binPath = join(binDir, 'lightpanda');
    if (existsSync(binPath)) {
      reporter.start('lightpanda', 'Installing Lightpanda');
      reporter.success('lightpanda', 'already installed');
      return { lightpanda: 'ok' };
    }
    const url = getLightpandaUrl();
    mkdirSync(binDir, { recursive: true });

    const head = await fetch(url, { method: 'HEAD' });
    const totalBytes = Number(head.headers.get('content-length') ?? 0);

    reporter.start('lightpanda', 'Downloading Lightpanda', { totalBytes: totalBytes || undefined });

    const resp = await fetch(url);
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }

    let downloaded = 0;
    const reader = resp.body.getReader();
    const ws = createWriteStream(binPath);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ws.write(value)) await new Promise<void>((resolve) => ws.once('drain', resolve));
        downloaded += value.byteLength;
        if (totalBytes > 0) reporter.progress('lightpanda', downloaded / totalBytes);
      }
    } finally {
      ws.end();
      await new Promise<void>((resolve) => ws.once('finish', () => resolve()));
    }

    chmodSync(binPath, 0o755);
    reporter.success('lightpanda', 'installed');
    return { lightpanda: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('lightpanda', message);
    return { lightpanda: 'failed', lightpandaError: message };
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

  let trafStatus: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (flagSet.has('--trafilatura') || flagSet.has('--all')) {
    trafStatus = await installTrafilatura(config.dataDir, reporterImpl);
  }

  let rerankerResult: Pick<WarmupResult, 'reranker' | 'rerankerError'> = {};
  if (flagSet.has('--reranker') || flagSet.has('--all')) {
    rerankerResult = await installFlashRank(config.dataDir, reporterImpl);
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
    embeddingsResult = await installSentenceTransformers(config.dataDir, reporterImpl);
  }

  let lightpandaResult: Pick<WarmupResult, 'lightpanda' | 'lightpandaError'> = {};
  if (flagSet.has('--lightpanda') || flagSet.has('--all')) {
    lightpandaResult = await installLightpanda(reporterImpl);
  }

  const result: WarmupResult = {
    ...pwResult,
    ...searxngResult,
    trafilatura: trafStatus,
    ...rerankerResult,
    ...firefoxResult,
    ...webkitResult,
    ...embeddingsResult,
    ...lightpandaResult,
  };

  reporterImpl.note('');
  reporterImpl.note('Summary:');
  reporterImpl.note(`  Browser:       ${result.playwright}${result.playwrightError ? ` (${result.playwrightError})` : ''}`);
  reporterImpl.note(`  Search engine: ${result.searxng}${result.searxngError ? ` (${result.searxngError})` : ''}`);
  if (trafStatus !== 'skipped') reporterImpl.note(`  Content extractor: ${trafStatus}`);
  if (result.reranker) reporterImpl.note(`  ML reranker:   ${result.reranker}${result.rerankerError ? ` (${result.rerankerError})` : ''}`);
  if (result.firefox) reporterImpl.note(`  Firefox:       ${result.firefox}${result.firefoxError ? ` (${result.firefoxError})` : ''}`);
  if (result.webkit) reporterImpl.note(`  WebKit:        ${result.webkit}${result.webkitError ? ` (${result.webkitError})` : ''}`);
  if (result.embeddings) reporterImpl.note(`  Embeddings:    ${result.embeddings}${result.embeddingsError ? ` (${result.embeddingsError})` : ''}`);
  if (result.lightpanda) reporterImpl.note(`  Lightpanda:    ${result.lightpanda}${result.lightpandaError ? ` (${result.lightpandaError})` : ''}`);

  if (flagSet.has('--verify') || flagSet.has('--all')) {
    await runVerify(config.dataDir, reporterImpl);
  }

  reporterImpl.finish();
  return result;
}
