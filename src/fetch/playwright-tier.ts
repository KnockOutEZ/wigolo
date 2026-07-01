import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';
import { HYDRATION_PROBE_SOURCE, APP_SHELL_ONLY_SOURCE } from './hydration-probe.js';
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
    // A fast load can win its race while the budget is already exhausted —
    // bail before entering the post-goto waits so a never-idling SPA can't
    // hold the slot past the budget.
    if (opts.signal?.aborted) throw opts.signal.reason;
    // SPAs (React/Next.js/etc.) populate the article body after `load` fires.
    // Nav-shell docs sites (react.dev, nextjs.org) ship a header + sidebar
    // that clears `networkidle` and exceeds any plain body.innerText threshold
    // BEFORE the article mounts — so the hydration probe (a `<main>`/`<article>`
    // with substantial body text) is the gate, NOT a competitor in a race.
    //
    // The previous Promise.race([probe, networkidle]) was the SPA nav-only bug:
    // networkidle settles first on these sites, the race resolves, and
    // page.content() captures the nav-only shell before the body mounts. Here
    // we instead (1) let the network settle (bounded, best-effort), then
    // (2) AWAIT the hydration probe as the gate, then (3) if the probe still
    // times out and the DOM is an SPA app-shell with no body yet, re-poll once
    // before giving up. Each wait still races abort so an abort DURING a wait
    // rejects promptly.
    //
    // BUDGET: all three post-goto phases draw from ONE shared deadline computed
    // once here, never per-leg. Two callers (extract.ts, router stealth tier)
    // pass neither timeoutMs nor signal, so `overall` is 30000 and nothing
    // would otherwise clamp the legs — three independent 5s/5s/6s waits would
    // triple worst-case post-goto wall-clock to ~16s, re-introducing the
    // latency blowup. A single deadline guarantees total post-goto
    // time can never exceed the cap regardless of signal/timeoutMs.
    //
    // Within that one deadline we still reserve room for the escalation re-poll:
    // the networkidle wait and the FIRST probe wait are each capped to a slice
    // (so a slow first probe can't eat the whole budget and starve escalation),
    // and the escalation re-poll then draws whatever budget survives. Every leg
    // is additionally clamped to `remaining()`, so the legs can only ever sum
    // to the shared deadline.
    const POST_GOTO_CAP = 6000;
    const NETWORKIDLE_SLICE = 2000;
    const FIRST_PROBE_SLICE = 2500;
    const postGotoDeadline = Date.now() + Math.min(overall, POST_GOTO_CAP);
    const remaining = () => Math.max(0, postGotoDeadline - Date.now());

    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: Math.min(remaining(), NETWORKIDLE_SLICE) }).catch(() => undefined),
      abortRejection(opts.signal),
    ]).catch((err) => {
      if (opts.signal?.aborted) throw err;
    });
    if (opts.signal?.aborted) throw opts.signal.reason;

    let hydrated = await Promise.race([
      page.waitForFunction(HYDRATION_PROBE_SOURCE, undefined, { timeout: Math.min(remaining(), FIRST_PROBE_SLICE) })
        .then(() => true)
        .catch(() => false),
      abortRejection(opts.signal),
    ]).catch((err) => {
      if (opts.signal?.aborted) throw err;
      return false;
    });

    // The probe timed out. Distinguish "this is an app-shell still mounting"
    // (worth a longer re-poll) from "this is just a non-SPA page with no
    // semantic body" (return as-is). Only escalate on the former, and only if
    // the shared deadline still has budget — so already-fast pages and pages
    // that already burned the budget pay nothing here.
    if (!hydrated && !opts.signal?.aborted && remaining() > 0) {
      const appShellOnly = await page.evaluate(APP_SHELL_ONLY_SOURCE).catch(() => false);
      if (appShellOnly && remaining() > 0) {
        const escalationBudget = remaining();
        log.debug('app-shell only after first hydration wait; re-polling for body', { url, escalationBudget });
        hydrated = await Promise.race([
          page.waitForFunction(HYDRATION_PROBE_SOURCE, undefined, { timeout: escalationBudget })
            .then(() => true)
            .catch(() => false),
          abortRejection(opts.signal),
        ]).catch((err) => {
          if (opts.signal?.aborted) throw err;
          return false;
        });
        if (!hydrated) {
          log.warn('SPA body did not mount within budget; capturing partial content', { url });
        }
      }
    }
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return { html, text };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    // Close the page; tolerate already-closed (double-close is safe).
    await page.close().catch(() => {});
  }
}
