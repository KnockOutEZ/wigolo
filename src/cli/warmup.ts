import { execSync } from 'node:child_process';
import { getConfig } from '../config.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';

export interface WarmupResult {
  playwright: 'ok' | 'failed';
  playwrightError?: string;
  searxng: 'ready' | 'bootstrapped' | 'failed' | 'no_python';
  searxngError?: string;
  trafilatura?: 'ok' | 'failed' | 'skipped';
}

function log(msg: string): void {
  process.stderr.write(`[wigolo warmup] ${msg}\n`);
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

  const flagSet = new Set(flags);
  let trafStatus: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (flagSet.has('--trafilatura') || flagSet.has('--all')) {
    trafStatus = installTrafilatura();
  }

  const result: WarmupResult = { ...pwResult, ...searxngResult, trafilatura: trafStatus };

  log('');
  log('Summary:');
  log(`  Playwright:    ${result.playwright}${result.playwrightError ? ` (${result.playwrightError})` : ''}`);
  log(`  SearXNG:       ${result.searxng}${result.searxngError ? ` (${result.searxngError})` : ''}`);
  if (trafStatus !== 'skipped') {
    log(`  Trafilatura:   ${trafStatus}`);
  }

  return result;
}
