import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { resetAvailabilityCache } from '../search/flashrank.js';

export interface WarmupResult {
  playwright: 'ok' | 'failed';
  playwrightError?: string;
  searxng: 'ready' | 'bootstrapped' | 'failed' | 'no_python';
  searxngError?: string;
  trafilatura?: 'ok' | 'failed' | 'skipped';
  reranker?: 'ok' | 'failed';
  rerankerError?: string;
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

function installTrafilatura(): 'ok' | 'failed' {
  log('Installing Trafilatura...');
  try {
    execSync('python3 -m pip install --quiet trafilatura', {
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

function installFlashRank(): Pick<WarmupResult, 'reranker' | 'rerankerError'> {
  log('Installing FlashRank...');
  try {
    execSync('python3 -m pip install --quiet flashrank', { stdio: 'pipe', timeout: 120000 });
    resetAvailabilityCache();
    log('FlashRank installed successfully');
    return { reranker: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FlashRank install failed: ${message}`);
    return { reranker: 'failed', rerankerError: message };
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
    trafStatus = installTrafilatura();
  }

  let rerankerResult: Pick<WarmupResult, 'reranker' | 'rerankerError'> = {};
  if (flagSet.has('--reranker') || flagSet.has('--all')) {
    rerankerResult = installFlashRank();
  }

  const result: WarmupResult = { ...pwResult, ...searxngResult, trafilatura: trafStatus, ...rerankerResult };

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

  return result;
}
