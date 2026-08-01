import { createLogger } from '../logger.js';
import { redactUrl } from '../util/redact-url.js';
import type { Logger } from '../logger.js';
import type { Browser } from 'playwright';

/**
 * Opt-in hosted Scraping-Browser CDP rung (Bright-Data-style).
 *
 * The honest paid answer for when keyless anti-bot runs out: a hosted browser
 * endpoint provides IP rotation + challenge solving + a server-side fingerprint,
 * reached over a CDP websocket. When `WIGOLO_SCRAPING_BROWSER_WSS`
 * (config `scrapingBrowserWss`) is set, an escalation rung connects here via
 * `chromium.connectOverCDP(wss)` instead of launching a local browser; the
 * caller (the browser tier) then drives navigate/extract on the returned live
 * Browser exactly as it would a locally-launched one.
 *
 * Security / honesty posture:
 *   - OFF by default — `null`/empty `wss` is a hard no-op (returns `null`, never
 *     touches the connector). A default install never reaches this module.
 *   - This rung EGRESSES off-machine (the hosted endpoint fetches the target on
 *     its own IP), so the connect is logged at info, mirroring the
 *     escape-hatch's honest logging.
 *   - The `wss` carries provider credentials in its userinfo — that is expected
 *     for this rung, so it is REDACTED via `redactUrl` in every log line.
 *   - Scheme is validated (`ws:`/`wss:` only) to avoid handing an arbitrary URL
 *     to the browser connector; anything else is refused (returns `null` +
 *     warn). The target URL itself stays guarded by the caller's fetch policy.
 */

const defaultLogger = createLogger('fetch');

/** A live connected browser + a disconnect. The caller owns navigate/extract. */
export interface ScrapingBrowserHandle {
  browser: Browser;
  close(): Promise<void>;
}

/**
 * Connector that opens a Browser over a CDP websocket endpoint. Injectable so
 * tests never touch a real network / real Playwright. Defaults to a lazy
 * `import('playwright')` → `chromium.connectOverCDP(wss)`.
 */
export type CdpConnector = (wss: string) => Promise<Browser>;

export interface ConnectScrapingBrowserOptions {
  /** The hosted CDP websocket endpoint (credential-bearing userinfo expected). */
  wss: string | null | undefined;
  /** Abort signal — an already-aborted signal short-circuits to `null`. */
  signal?: AbortSignal;
  /** Connect timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Injectable connector (tests). Defaults to Playwright's chromium.connectOverCDP. */
  connect?: CdpConnector;
  /** Injectable logger (tests). Defaults to the module logger. */
  logger?: Logger;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Lazy default connector: only resolves Playwright when this rung is used. */
const lazyPlaywrightConnect: CdpConnector = async (wss) => {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(wss);
};

/** True when `wss` is a syntactically valid `ws:`/`wss:` URL. */
function isValidWssScheme(wss: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(wss);
  } catch {
    return false;
  }
  return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
}

/**
 * Connect to a hosted Scraping-Browser CDP endpoint and return a live Browser
 * handle, or `null` when the rung is OFF (no `wss`), the `wss` scheme is invalid,
 * the signal is already aborted, or the connect fails / times out.
 *
 * This is content-fetch shaped only: it hands back a connected Browser. The
 * actual navigate + extract stays with the caller, which already owns the
 * browser tier.
 */
export async function connectScrapingBrowser(
  opts: ConnectScrapingBrowserOptions,
): Promise<ScrapingBrowserHandle | null> {
  const log = opts.logger ?? defaultLogger;
  const wss = opts.wss;

  // OFF by default: no endpoint configured → hard no-op, connector never called.
  if (!wss) return null;

  if (opts.signal?.aborted) {
    log.debug('scraping-browser: signal already aborted, not connecting');
    return null;
  }

  if (!isValidWssScheme(wss)) {
    log.warn('scraping-browser endpoint rejected: scheme must be ws:// or wss://', {
      endpoint: redactUrl(wss),
    });
    return null;
  }

  const connect = opts.connect ?? lazyPlaywrightConnect;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  // Off-machine egress: this endpoint fetches the target on its own IP. Log it
  // transparently (credential userinfo redacted), mirroring the escape-hatch.
  log.info('routing via hosted scraping-browser endpoint (off-machine egress)', {
    endpoint: redactUrl(wss),
  });

  let browser: Browser;
  try {
    browser = await withTimeoutAndAbort(connect(wss), timeoutMs, opts.signal);
  } catch (err) {
    log.warn('scraping-browser connect failed', {
      endpoint: redactUrl(wss),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let closed = false;
  return {
    browser,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } catch (err) {
        log.debug('scraping-browser: browser close errored (ignored)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * Race a connect promise against a timeout and an abort signal. Rejects on
 * whichever fires first so a hung / slow hosted endpoint never blocks forever.
 */
/** Best-effort close of a browser nobody is waiting for any more. Never throws
 *  — it runs detached from any caller, so a rejection here has nowhere to go. */
async function closeStrandedBrowser(value: unknown): Promise<void> {
  const closable = value as { close?: () => Promise<void> | void } | null;
  if (!closable || typeof closable.close !== 'function') return;
  try {
    await closable.close();
    defaultLogger.debug('scraping-browser: closed a connection that arrived after timeout/abort');
  } catch {
    /* nothing further we can do from here */
  }
}

function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`scraping-browser connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('scraping-browser connect aborted'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (value) => {
        if (settled) {
          // The connect won the race against nothing — we already rejected on
          // timeout/abort and the caller has moved on. Nobody will ever close
          // this browser, and it is a HOSTED one: left open it keeps running
          // (and billing) on the provider's side until their own idle timeout.
          void closeStrandedBrowser(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}
