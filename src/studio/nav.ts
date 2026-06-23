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
  private readonly policyProvider: () => NavPolicy;
  /** D4/A: bump the session nav-epoch on each ALLOWED committed Document hop (set by the host; absent in tests that don't track epochs). */
  private readonly onAllowedNavigation?: () => void;
  /** Document requestIds currently being evaluated / in flight — the set abortInFlight fails closed on a reclaim. */
  private readonly inFlight = new Set<string>();

  /**
   * PULL-AT-EVAL: the interceptor reads the LIVE policy from `policyProvider` at the
   * moment it evaluates each hop, rather than caching a policy that a flip must
   * re-arm. This removes any disarm→re-arm transition window — the instant the
   * control token flips to the agent, the next hop (including a redirect hop already
   * mid-chain) is judged under the agent policy, never the more-permissive policy of
   * a moment earlier.
   */
  constructor(policyProvider: () => NavPolicy, onAllowedNavigation?: () => void) {
    this.policyProvider = policyProvider;
    this.onAllowedNavigation = onAllowedNavigation;
  }

  /** Begin intercepting document navigations on this CDP session. */
  async start(cdp: NavCdp): Promise<void> {
    this.cdp = cdp;
    cdp.on('Fetch.requestPaused', this.onPaused);
    try {
      await cdp.send('Fetch.enable', { patterns: [DOCUMENT_PATTERN] });
    } catch (err) {
      // FAIL-CLOSED: a half-armed interceptor (listener attached but the Fetch
      // domain NOT enabled → Chromium emits no requestPaused events) would silently
      // pass every navigation unguarded. Leave a clean unbound state and propagate
      // so the caller (boot or crash recovery) fails closed rather than open.
      cdp.off('Fetch.requestPaused', this.onPaused);
      this.cdp = null;
      throw err;
    }
  }

  /** Move interception to a fresh CDP session after a crash recovery. */
  async rebind(cdp: NavCdp): Promise<void> {
    if (this.cdp) this.cdp.off('Fetch.requestPaused', this.onPaused);
    this.inFlight.clear(); // the dead cdp's in-flight requestIds are meaningless on the fresh one
    await this.start(cdp);
  }

  /** Stop intercepting (host shutdown). */
  async stop(): Promise<void> {
    if (!this.cdp) return;
    const cdp = this.cdp;
    this.cdp = null;
    this.inFlight.clear();
    cdp.off('Fetch.requestPaused', this.onPaused);
    await cdp.send('Fetch.disable').catch(() => {});
  }

  /**
   * Abort the agent's in-flight navigation on a human reclaim (the nav analog of the
   * in-flight-click abort): stop the in-flight load and fail any hop still being
   * evaluated, so a nav started under a now-revoked grant cannot complete. A
   * half-loaded page is fine — the human is driving now. Page.stopLoading is the
   * primary cancel; failing the tracked hops closes the micro-window where a paused
   * hop would otherwise be re-evaluated under the looser human policy.
   */
  async abortInFlight(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const pending = [...this.inFlight];
    this.inFlight.clear();
    // Cancel the in-flight load FIRST so the browser stops emitting further redirect
    // hops, THEN fail any hop still paused at the interceptor — shrinks the window in
    // which a new redirect hop could arrive mid-abort and be evaluated under the
    // (looser) post-reclaim human policy.
    await cdp.send('Page.stopLoading').catch(() => {});
    for (const requestId of pending) {
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
    }
  }

  private onPaused = (event: NavRequestPaused): void => {
    const cdp = this.cdp;
    if (!cdp) return;
    const requestId = event.requestId;
    this.inFlight.add(requestId);
    // FAIL-CLOSED: re-validate under the LIVE policy, continue only an allowed hop; any error → fail it.
    void (async () => {
      try {
        const policy = this.policyProvider();
        const verdict = guardNavigation(event.request?.url ?? '', policy);
        if (verdict.ok) {
          await cdp.send('Fetch.continueRequest', { requestId });
          // D4/A: bump the session nav-epoch on an ALLOWED committed Document hop ONLY (post-continue). A
          // guard-BLOCKED hop (the else branch) did not change the page, so it must not bump — else a capture
          // against the still-current page would false-abort.
          this.onAllowedNavigation?.();
        } else {
          log.debug('blocked navigation hop', { url: event.request?.url, source: policy.source });
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' });
        }
      } catch (err) {
        log.debug('nav interceptor error — failing closed', { error: err instanceof Error ? err.message : String(err) });
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }).catch(() => {});
      } finally {
        this.inFlight.delete(requestId);
      }
    })();
  };
}

/** A session browser the nav guard can drive (the live SessionBrowser satisfies this). */
export interface NavigableBrowser {
  navigate(url: string): Promise<void>;
}

export interface NavigateSessionOptions {
  /**
   * Host-authoritative epoch fence. Called SYNCHRONOUSLY immediately before the CDP
   * nav command goes out; return false to abort. Closes the gate→nav-start TOCTOU: the
   * control-token gate may have passed, then a human reclaim landed before `goto` —
   * there is no in-flight nav for the reclaim's abort to cancel yet, so this check is
   * what stops the agent navigating under a just-revoked grant. There is no `await`
   * between this call and `browser.navigate`, so on the single-threaded host the check
   * and the nav-command dispatch are atomic. Downstream hops are re-validated by the
   * (pull-at-eval) NavInterceptor; an in-flight reclaim is handled by its abort.
   */
  beforeNavigate?: () => boolean;
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
  opts?: NavigateSessionOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verdict = guardNavigation(url, policy);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.code === 'blocked' ? 'navigation_blocked' : `navigation_${verdict.code}` };
  }
  if (opts?.beforeNavigate && !opts.beforeNavigate()) {
    // A reclaim fired in the gate→start window — stand down, never navigate under a
    // revoked grant. Distinct reason so the agent reads "human took over, don't retry".
    return { ok: false, reason: 'aborted_reclaimed' };
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
