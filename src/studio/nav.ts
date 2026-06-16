import { createLogger } from '../logger.js';
import { guardNavigation, type NavSource } from '../security/ssrf.js';

/**
 * Session navigation guard. Two layers:
 *  - `navigateSession` guards the URL the human types before `page.goto`.
 *  - `NavInterceptor` re-validates EVERY navigation hop via CDP `Fetch` — the
 *    classic SSRF-via-redirect bypass (a benign public URL that 302s to
 *    169.254.169.254) is caught because each redirect target is a fresh Document
 *    request that re-pauses and re-hits the guard with the same source policy.
 *
 * Design constraints (deliberate):
 *  - Scoped to `Document` requests at the Request stage — NOT every resource
 *    (images/CSS/JS), which would tank page-load latency and is the wrong layer.
 *  - FAIL-CLOSED: any error re-validating or continuing a request → fail it. A
 *    guard that fails open is worse than none.
 *  - Bound to the session's CDP session; `rebind` on crash recovery; clean teardown.
 *
 * The fetch/crawl path (`http-client.ts`) is untouched — this guard rides the
 * browser's CDP layer, so legitimate public→public fetch redirects are unaffected.
 */

const log = createLogger('studio');

export interface NavCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, cb: (payload: NavRequestPaused) => void): void;
  off(event: string, cb: (payload: NavRequestPaused) => void): void;
}

interface NavRequestPaused {
  requestId: string;
  request: { url: string };
  resourceType?: string;
}

export interface NavPolicy {
  source: NavSource;
  allowPrivate?: boolean;
}

const DOCUMENT_PATTERN = { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' } as const;

export class NavInterceptor {
  private cdp: NavCdp | null = null;
  private policy: NavPolicy;

  constructor(policy: NavPolicy) {
    this.policy = policy;
  }

  /** Update the policy applied to subsequent hops (e.g. switch to the agent policy in Phase 2). */
  setPolicy(policy: NavPolicy): void {
    this.policy = policy;
  }

  /** Begin intercepting document navigations on this CDP session. */
  async start(cdp: NavCdp): Promise<void> {
    this.cdp = cdp;
    cdp.on('Fetch.requestPaused', this.onPaused);
    await cdp.send('Fetch.enable', { patterns: [DOCUMENT_PATTERN] });
  }

  /** Move interception to a fresh CDP session after a crash recovery. */
  async rebind(cdp: NavCdp): Promise<void> {
    if (this.cdp) this.cdp.off('Fetch.requestPaused', this.onPaused);
    await this.start(cdp);
  }

  /** Stop intercepting (host shutdown). */
  async stop(): Promise<void> {
    if (!this.cdp) return;
    const cdp = this.cdp;
    this.cdp = null;
    cdp.off('Fetch.requestPaused', this.onPaused);
    await cdp.send('Fetch.disable').catch(() => {});
  }

  private onPaused = (event: NavRequestPaused): void => {
    const cdp = this.cdp;
    if (!cdp) return;
    // FAIL-CLOSED: re-validate, continue only an allowed hop; any error → fail it.
    void (async () => {
      try {
        const verdict = guardNavigation(event.request?.url ?? '', this.policy);
        if (verdict.ok) {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        } else {
          log.debug('blocked navigation hop', { url: event.request?.url, source: this.policy.source });
          await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'AccessDenied' });
        }
      } catch (err) {
        log.debug('nav interceptor error — failing closed', { error: err instanceof Error ? err.message : String(err) });
        await cdp
          .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'AccessDenied' })
          .catch(() => {});
      }
    })();
  };
}

/** A session browser the nav guard can drive (the live SessionBrowser satisfies this). */
export interface NavigableBrowser {
  navigate(url: string): Promise<void>;
}

/**
 * Guard the URL a party asks to navigate to, then drive the browser. The
 * per-hop redirect re-validation is handled separately by NavInterceptor; this
 * gates the INITIAL target before `goto`.
 */
export async function navigateSession(
  browser: NavigableBrowser,
  url: string,
  policy: NavPolicy,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verdict = guardNavigation(url, policy);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.code === 'blocked' ? 'navigation_blocked' : `navigation_${verdict.code}` };
  }
  try {
    await browser.navigate(url);
    return { ok: true };
  } catch (err) {
    // The goto can reject because a redirect HOP was blocked by the interceptor
    // (or any nav failure) — surface it cleanly rather than throwing into the host.
    log.debug('navigation failed', { url, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: 'navigation_failed' };
  }
}
