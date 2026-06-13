import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';
import { HYDRATION_PROBE_SOURCE } from './hydration-probe.js';
import { abortRejection } from '../util/abort.js';

const log = createLogger('playwright-tier');

export interface InstallStatus {
  installed: boolean;
  hint?: string;
}

export async function detectPlaywrightInstall(): Promise<InstallStatus> {
  try {
    const exec = chromium.executablePath();
    if (exec && existsSync(exec)) return { installed: true };
    return { installed: false, hint: 'npx playwright install chromium' };
  } catch {
    return { installed: false, hint: 'npx playwright install chromium' };
  }
}

export function shouldEscalate(body: string): boolean {
  if (!body) return true;
  if (body.length < 500) return true;
  if (/enable javascript/i.test(body)) return true;
  return false;
}

let _browser: Browser | null = null;
let _ctx: BrowserContext | null = null;
let _launching: Promise<{ browser: Browser; context: BrowserContext }> | null = null;

export async function getDaemonBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  if (_browser && _ctx) return { browser: _browser, context: _ctx };
  if (_launching) return _launching;
  _launching = (async () => {
    try {
      const status = await detectPlaywrightInstall();
      if (!status.installed) {
        const err = new Error('playwright_not_installed') as Error & { hint?: string };
        err.hint = status.hint;
        throw err;
      }
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      _browser = browser;
      _ctx = context;
      log.info('Playwright daemon browser launched');
      return { browser, context };
    } finally {
      _launching = null;
    }
  })();
  return _launching;
}

export async function closeDaemonBrowser(): Promise<void> {
  _launching = null;
  if (_ctx) { await _ctx.close(); _ctx = null; }
  if (_browser) { await _browser.close(); _browser = null; }
}

export async function fetchWithPlaywright(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ html: string; text: string }> {
  // Bail out immediately if the caller's budget is already exhausted.
  if (opts.signal?.aborted) throw opts.signal.reason;

  const { context } = await getDaemonBrowser();
  const page = await context.newPage();

  // When the caller's signal fires, close THIS page so the in-flight
  // navigation is cancelled. The shared daemon context is never closed here.
  const onAbort = () => { page.close().catch(() => {}); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const overall = opts.timeoutMs ?? 30000;
    // Race the navigation against the caller's abort signal.
    // abortRejection never settles when no signal is given (safe loser in race).
    await Promise.race([
      page.goto(url, { waitUntil: 'load', timeout: overall }),
      abortRejection(opts.signal),
    ]);
    // SPAs (React/Next.js/etc.) populate the article body after `load` fires.
    // Wait for either semantic content (a `<main>`/`<article>` containing
    // substantial text) or for the network to go idle — whichever wins
    // first. Plain body innerText > N isn't enough because nav-shell sites
    // (react.dev, nextjs.org) ship a header + sidebar that already exceeds
    // any reasonable text threshold before the article mounts.
    const hydrationBudget = Math.min(5000, Math.max(800, Math.floor(overall / 6)));
    await Promise.race([
      page.waitForFunction(HYDRATION_PROBE_SOURCE, undefined, { timeout: hydrationBudget }).catch(() => undefined),
      page.waitForLoadState('networkidle', { timeout: hydrationBudget }).catch(() => undefined),
    ]);
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return { html, text };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    // Close the page; tolerate already-closed (double-close is safe).
    await page.close().catch(() => {});
  }
}
