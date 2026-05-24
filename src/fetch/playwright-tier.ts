import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';

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

export async function fetchWithPlaywright(url: string, opts: { timeoutMs?: number } = {}): Promise<{ html: string; text: string }> {
  const { context } = await getDaemonBrowser();
  const page = await context.newPage();
  try {
    const overall = opts.timeoutMs ?? 30000;
    await page.goto(url, { waitUntil: 'load', timeout: overall });
    // SPAs (React/Next.js/etc.) populate the DOM after `load` fires.
    // Wait for either substantial body text or for the network to go idle —
    // whichever wins first — then bail out so we never block longer than the
    // hydration budget. Both branches swallow timeout errors because the
    // page may legitimately be static.
    const hydrationBudget = Math.min(3000, Math.max(500, Math.floor(overall / 10)));
    await Promise.race([
      page.waitForFunction(
        () => (document.body?.innerText ?? '').length > 500,
        undefined,
        { timeout: hydrationBudget },
      ).catch(() => undefined),
      page.waitForLoadState('networkidle', { timeout: hydrationBudget }).catch(() => undefined),
    ]);
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return { html, text };
  } finally {
    await page.close();
  }
}
