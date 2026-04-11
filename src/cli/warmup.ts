import { execSync } from 'node:child_process';
import { getConfig } from '../config.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';

export interface WarmupResult {
  playwright: 'ok' | 'failed';
  playwrightError?: string;
  searxng: 'ready' | 'bootstrapped' | 'failed' | 'no_python';
  searxngError?: string;
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

function setupSearxng(dataDir: string): Pick<WarmupResult, 'searxng' | 'searxngError'> {
  const state = getBootstrapState(dataDir);

  if (state?.status === 'ready') {
    log('SearXNG already set up');
    return { searxng: 'ready' };
  }

  if (!checkPythonAvailable()) {
    log('Python 3 not found — SearXNG requires Python. Install Python 3 or use Docker mode (SEARXNG_MODE=docker)');
    return { searxng: 'no_python' };
  }

  return { searxng: 'pending' as WarmupResult['searxng'] };
}

export async function runWarmup(): Promise<WarmupResult> {
  log('Starting warmup...');
  const config = getConfig();

  const pwResult = installPlaywright();

  const searxngCheck = setupSearxng(config.dataDir);
  let searxngResult: Pick<WarmupResult, 'searxng' | 'searxngError'>;

  if (searxngCheck.searxng === 'pending') {
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

  const result: WarmupResult = { ...pwResult, ...searxngResult };

  log('');
  log('Summary:');
  log(`  Playwright: ${result.playwright}${result.playwrightError ? ` (${result.playwrightError})` : ''}`);
  log(`  SearXNG:    ${result.searxng}${result.searxngError ? ` (${result.searxngError})` : ''}`);

  return result;
}
