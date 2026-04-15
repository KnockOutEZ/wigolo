import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive, SearxngProcess } from '../searxng/process.js';
import { resetAvailabilityCache } from '../search/flashrank.js';
import { getPythonBin } from '../python-env.js';

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

function log(msg: string): void {
  process.stderr.write(`[wigolo warmup] ${msg}\n`);
}

function wipeSearxngState(dataDir: string): void {
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
      // malformed lock → treat as stale, fall through to wipe
    }
  }
  rmSync(join(dataDir, 'state.json'), { force: true });
  rmSync(join(dataDir, 'searxng'), { recursive: true, force: true });
  rmSync(bootstrapLockPath, { force: true });
  rmSync(join(dataDir, 'searxng.lock'), { force: true });
  rmSync(join(dataDir, 'searxng.port'), { force: true });
  log('Wiped SearXNG state, install, and locks (--force)');
}

function installPlaywright(): Pick<WarmupResult, 'playwright' | 'playwrightError'> {
  log('Installing Playwright Chromium...');
  try {
    execSync('npx playwright install chromium', { stdio: 'pipe', timeout: 120000 });
    log('Playwright Chromium installed');
    return { playwright: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Playwright install failed: ${message}`);
    return { playwright: 'failed', playwrightError: message };
  }
}

function installTrafilatura(dataDir: string): 'ok' | 'failed' {
  log('Installing Trafilatura...');
  try {
    const py = getPythonBin(dataDir);
    execSync(`${py} -m pip install --quiet trafilatura`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    log('Trafilatura installed');
    return 'ok';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Trafilatura install failed: ${message}`);
    return 'failed';
  }
}

function installFlashRank(dataDir: string): Pick<WarmupResult, 'reranker' | 'rerankerError'> {
  log('Installing FlashRank...');
  try {
    const py = getPythonBin(dataDir);
    execSync(`${py} -m pip install --quiet flashrank`, { stdio: 'pipe', timeout: 120000 });
    resetAvailabilityCache();
    log('FlashRank installed successfully');
    return { reranker: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FlashRank install failed: ${message}`);
    return { reranker: 'failed', rerankerError: message };
  }
}

function installFirefox(): Pick<WarmupResult, 'firefox' | 'firefoxError'> {
  log('Installing Playwright Firefox...');
  try {
    execSync('npx playwright install firefox', { stdio: 'pipe', timeout: 120000 });
    log('Playwright Firefox installed');
    return { firefox: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Firefox install failed: ${message}`);
    return { firefox: 'failed', firefoxError: message };
  }
}

function installSentenceTransformers(dataDir: string): Pick<WarmupResult, 'embeddings' | 'embeddingsError'> {
  log('Installing sentence-transformers...');
  try {
    const py = getPythonBin(dataDir);
    execSync(`${py} -m pip install --quiet sentence-transformers`, {
      stdio: 'pipe',
      timeout: 300000,
    });
    log('sentence-transformers installed successfully');
    return { embeddings: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sentence-transformers install failed: ${message}`);
    return { embeddings: 'failed', embeddingsError: message };
  }
}

function getLightpandaUrl(): string {
  const platform = process.platform;
  const arch = process.arch;
  const base = 'https://github.com/lightpanda-io/browser/releases/download/nightly';
  if (platform === 'darwin' && arch === 'arm64') return `${base}/lightpanda-aarch64-macos`;
  if (platform === 'linux' && arch === 'x64') return `${base}/lightpanda-x86_64-linux`;
  throw new Error(`Lightpanda not available for ${platform}/${arch}`);
}

function installLightpanda(): Pick<WarmupResult, 'lightpanda' | 'lightpandaError'> {
  log('Installing Lightpanda...');
  try {
    const config = getConfig();
    const binDir = join(config.dataDir, 'bin');
    const binPath = join(binDir, 'lightpanda');
    if (existsSync(binPath)) {
      log('Lightpanda already installed');
      return { lightpanda: 'ok' };
    }
    const url = getLightpandaUrl();
    execSync(`mkdir -p "${binDir}" && curl -fsSL "${url}" -o "${binPath}" && chmod +x "${binPath}"`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    log('Lightpanda installed');
    return { lightpanda: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Lightpanda install failed: ${message}`);
    return { lightpanda: 'failed', lightpandaError: message };
  }
}

async function runVerify(dataDir: string): Promise<void> {
  log('');
  log('Verifying setup...');

  const searxngPath = join(dataDir, 'searxng');
  const proc = new SearxngProcess(searxngPath, dataDir);
  let url: string | null = null;
  try {
    url = await proc.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  SearXNG:       FAILED to start (${message})`);
    try { await proc.stop(); } catch {}
    return;
  }

  if (!url) {
    log('  SearXNG:       FAILED to start');
    try { await proc.stop(); } catch {}
    return;
  }

  log(`  SearXNG:       OK (${url})`);

  try {
    const response = await fetch(`${url}/search?q=test&format=json`);
    if (response.ok) {
      const body = await response.json() as { results?: unknown[] };
      const count = Array.isArray(body.results) ? body.results.length : 0;
      log(`  Test search:   OK (${count} results)`);
    } else {
      log(`  Test search:   FAILED (HTTP ${response.status})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  Test search:   FAILED (${message})`);
  }

  const py = getPythonBin(dataDir);
  const pkgs: Array<[string, string]> = [
    ['flashrank', 'FlashRank'],
    ['trafilatura', 'Trafilatura'],
    ['sentence_transformers', 'Embeddings'],
  ];
  for (const [mod, label] of pkgs) {
    try {
      execSync(`${py} -c "import ${mod}"`, { stdio: 'pipe', timeout: 30000 });
      log(`  ${label.padEnd(13)}  OK`);
    } catch {
      log(`  ${label.padEnd(13)}  not installed`);
    }
  }

  try { await proc.stop(); } catch {}

  log('');
  log('✓ All systems ready. Connect to your AI tool:');
  log('  claude mcp add wigolo -- npx @staticn0va/wigolo');
}

function installWebkit(): Pick<WarmupResult, 'webkit' | 'webkitError'> {
  log('Installing Playwright WebKit...');
  try {
    execSync('npx playwright install webkit', { stdio: 'pipe', timeout: 120000 });
    log('Playwright WebKit installed');
    return { webkit: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`WebKit install failed: ${message}`);
    return { webkit: 'failed', webkitError: message };
  }
}

type SearxngCheckResult =
  | Pick<WarmupResult, 'searxng' | 'searxngError'>
  | { needsBootstrap: true };

function setupSearxng(dataDir: string): SearxngCheckResult {
  const state = getBootstrapState(dataDir);

  if (state?.status === 'ready') {
    log('SearXNG already set up');
    return { searxng: 'ready' };
  }

  if (!checkPythonAvailable()) {
    log('Python 3 not found — SearXNG requires Python. Install Python 3 or use Docker mode (SEARXNG_MODE=docker)');
    return { searxng: 'no_python' };
  }

  return { needsBootstrap: true };
}

export async function runWarmup(flags: string[] = []): Promise<WarmupResult> {
  log('Starting warmup...');
  const config = getConfig();

  const flagSet = new Set(flags);
  if (flagSet.has('--force')) {
    wipeSearxngState(config.dataDir);
  }

  const pwResult = installPlaywright();

  const searxngCheck = setupSearxng(config.dataDir);
  let searxngResult: Pick<WarmupResult, 'searxng' | 'searxngError'>;

  if ('needsBootstrap' in searxngCheck) {
    log('Bootstrapping SearXNG (this may take a minute)...');
    try {
      await bootstrapNativeSearxng(config.dataDir);
      log('SearXNG bootstrapped successfully');
      searxngResult = { searxng: 'bootstrapped' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`SearXNG bootstrap failed: ${message}`);
      searxngResult = { searxng: 'failed', searxngError: message };
    }
  } else {
    searxngResult = searxngCheck;
  }

  let trafStatus: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (flagSet.has('--trafilatura') || flagSet.has('--all')) {
    trafStatus = installTrafilatura(config.dataDir);
  }

  let rerankerResult: Pick<WarmupResult, 'reranker' | 'rerankerError'> = {};
  if (flagSet.has('--reranker') || flagSet.has('--all')) {
    rerankerResult = installFlashRank(config.dataDir);
  }

  let firefoxResult: Pick<WarmupResult, 'firefox' | 'firefoxError'> = {};
  if (flagSet.has('--firefox') || flagSet.has('--all')) {
    firefoxResult = installFirefox();
  }

  let webkitResult: Pick<WarmupResult, 'webkit' | 'webkitError'> = {};
  if (flagSet.has('--webkit') || flagSet.has('--all')) {
    webkitResult = installWebkit();
  }

  let embeddingsResult: Pick<WarmupResult, 'embeddings' | 'embeddingsError'> = {};
  if (flagSet.has('--embeddings') || flagSet.has('--all')) {
    embeddingsResult = installSentenceTransformers(config.dataDir);
  }

  let lightpandaResult: Pick<WarmupResult, 'lightpanda' | 'lightpandaError'> = {};
  if (flagSet.has('--lightpanda') || flagSet.has('--all')) {
    lightpandaResult = installLightpanda();
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

  log('');
  log('Summary:');
  log(`  Playwright:    ${result.playwright}${result.playwrightError ? ` (${result.playwrightError})` : ''}`);
  log(`  SearXNG:       ${result.searxng}${result.searxngError ? ` (${result.searxngError})` : ''}`);
  if (trafStatus !== 'skipped') {
    log(`  Trafilatura:   ${trafStatus}`);
  }
  if (result.reranker) {
    log(`  FlashRank:     ${result.reranker}${result.rerankerError ? ` (${result.rerankerError})` : ''}`);
  }
  if (result.firefox) {
    log(`  Firefox:       ${result.firefox}${result.firefoxError ? ` (${result.firefoxError})` : ''}`);
  }
  if (result.webkit) {
    log(`  WebKit:        ${result.webkit}${result.webkitError ? ` (${result.webkitError})` : ''}`);
  }
  if (result.embeddings) {
    log(`  Embeddings:    ${result.embeddings}${result.embeddingsError ? ` (${result.embeddingsError})` : ''}`);
  }
  if (result.lightpanda) {
    log(`  Lightpanda:    ${result.lightpanda}${result.lightpandaError ? ` (${result.lightpandaError})` : ''}`);
  }

  if (flagSet.has('--verify') || flagSet.has('--all')) {
    await runVerify(config.dataDir);
  }

  return result;
}
