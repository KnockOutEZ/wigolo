/**
 * Per-hop SSRF fence for the browser tier.
 *
 * The browser tier used to be the ONLY fetch tier with a pre-navigation host
 * check and no per-hop re-guard: `fetchWithBrowser` validated the URL it was
 * handed, then let Chromium follow the redirect chain unattended. A public URL
 * that 302s to 127.0.0.1 / 169.254.169.254 / an RFC1918 address was therefore
 * checked once and then followed — the classic redirect bypass that the HTTP,
 * TLS, cdp-direct and watch-webhook tiers all already close by re-guarding each
 * hop.
 *
 * This module closes it WITHOUT a second policy: every decision routes through
 * `guardFetchUrl` / `guardResolvedHost` in `watch/ssrf.ts`, the same pair the
 * other tiers call, so the browser tier cannot drift from them.
 *
 * SEAM CHOICE — why raw CDP `Fetch.enable` and not Playwright's `page.route`:
 * measured on playwright 1.60 against a two-hop redirect (see the integration
 * test), a `page.route('**')` handler is invoked for the INITIAL request only.
 * Chromium follows 3xx hops inside its own network stack and Playwright
 * auto-continues them, so the handler never sees the redirect target and the
 * blocked host is still reached. `Fetch.enable` with `requestStage: 'Request'`
 * DOES re-pause on every hop (each carries a `redirectedRequestId`), which is
 * the only in-process seam that can refuse the request before it is issued. A
 * local proxy was rejected upstream: Chromium's implicit proxy bypass means
 * loopback and link-local never reach a proxy at all unless
 * `proxyBypassRules: '<-loopback>'` is set, i.e. its correctness would rest on
 * one omittable string that fails OPEN invisibly.
 *
 * LIFETIME: the interceptor is attached to a CDP session opened on the
 * per-fetch page (`ctx.newCDPSession(page)`), not on the shared pooled context.
 * A context-level attach would accumulate one handler per fetch on a pooled
 * context that outlives them all. Page-scoped means the session dies with the
 * page in `fetchWithBrowser`'s `finally`, and nothing can silently replace it:
 * it is our own session, and `page.route` (which would contend for the Fetch
 * domain) appears nowhere in `src/`.
 *
 * NON-CHROMIUM: `newCDPSession` exists only on Chromium. On firefox/webkit the
 * install returns an inert handle and `assertNavigationChainAllowed` — which
 * runs on every engine after navigation — is the remaining fence. That is a
 * weaker guarantee (the request is issued, only the CONTENT is refused) and is
 * stated here rather than papered over.
 */

import type { CDPSession, Page } from 'playwright';
import { createLogger } from '../logger.js';
import { guardFetchUrl, guardResolvedHost, type LookupAll } from '../watch/ssrf.js';

const log = createLogger('fetch');

/**
 * Schemes that carry no network host and are served in-process by the renderer.
 * This is an ALLOW-list, not a deny-list: any scheme not named here and not
 * http(s) is refused, so a new exotic scheme fails closed.
 */
const HOSTLESS_SCHEMES = new Set(['data:', 'blob:', 'about:']);

export type BrowserGuardVerdict = { allowed: true } | { allowed: false; reason: string };

export interface EvaluateOptions {
  allowPrivate: boolean;
  /**
   * Also run the DNS-resolved re-check (`guardResolvedHost`). Reserved for
   * document/navigation requests: it costs a lookup per distinct host, and a
   * subresource cannot hand its bytes to the agent the way a navigated
   * document can. Callers that cannot tell what kind of request it is pass
   * `true` — more checking, not less.
   */
  resolve: boolean;
  /** Per-fetch memo so a multi-hop chain on one host resolves once, not per hop. */
  resolvedCache?: Map<string, BrowserGuardVerdict>;
  /** Injectable DNS for tests; production uses the node default inside `guardResolvedHost`. */
  lookup?: LookupAll;
}

/**
 * The fence decision for ONE browser request. Fails closed on missing or
 * unusable information — no URL, an unparseable URL, an unknown scheme — rather
 * than defaulting to allow.
 */
export async function evaluateBrowserRequestUrl(
  rawUrl: string | undefined | null,
  opts: EvaluateOptions,
): Promise<BrowserGuardVerdict> {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { allowed: false, reason: 'browser request carried no URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `browser request URL is unparseable (${rawUrl.slice(0, 120)})` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    if (HOSTLESS_SCHEMES.has(parsed.protocol)) return { allowed: true };
    return {
      allowed: false,
      reason: `browser request uses a forbidden protocol (${parsed.protocol})`,
    };
  }

  const literal = guardFetchUrl(rawUrl, 'browser request', { allowPrivate: opts.allowPrivate });
  if (!literal.ok) return { allowed: false, reason: `${literal.reason}. ${literal.hint}` };

  if (!opts.resolve) return { allowed: true };

  const host = parsed.hostname;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIpLiteral) return { allowed: true };

  const cached = opts.resolvedCache?.get(host);
  if (cached) return cached;

  const resolved = await guardResolvedHost(host, 'browser request', {
    allowPrivate: opts.allowPrivate,
    lookup: opts.lookup,
  });
  const verdict: BrowserGuardVerdict = resolved.ok
    ? { allowed: true }
    : { allowed: false, reason: `${resolved.reason}. ${resolved.hint}` };
  opts.resolvedCache?.set(host, verdict);
  return verdict;
}

/** Handle returned by {@link installBrowserRequestGuard}. */
export interface BrowserRequestGuard {
  /** True when a live CDP interceptor is refusing requests before they are issued. */
  readonly intercepting: boolean;
  /** The FIRST block reason recorded, or null. Kept first so the cause of a
   *  navigation failure is the fence's verdict, not a later cascade. */
  blockedReason(): string | null;
  dispose(): Promise<void>;
}

/** Minimal shape of the page/context seam we need, so unit tests can supply a stub. */
interface CdpCapablePage {
  context?: () => { newCDPSession?: (page: unknown) => Promise<CDPSession> } | null;
}

const INERT_GUARD: BrowserRequestGuard = {
  intercepting: false,
  blockedReason: () => null,
  dispose: async () => {},
};

/**
 * Attach the per-hop fence to `page`. Every request Chromium is about to issue —
 * the initial navigation, every 3xx hop, every subresource — is paused and run
 * through {@link evaluateBrowserRequestUrl}; a blocked one is failed with
 * `BlockedByClient` and never leaves the process.
 *
 * Returns an inert handle (nothing intercepted) when the page cannot give us a
 * CDP session: a non-Chromium engine, or a unit-test page stub. `intercepting`
 * reports which of the two happened so callers do not mistake one for the other.
 */
export async function installBrowserRequestGuard(
  page: Page,
  opts: { allowPrivate: boolean; lookup?: LookupAll },
): Promise<BrowserRequestGuard> {
  const maybe = page as unknown as CdpCapablePage;
  const ctx = typeof maybe.context === 'function' ? maybe.context() : null;
  if (!ctx || typeof ctx.newCDPSession !== 'function') return INERT_GUARD;

  let session: CDPSession;
  try {
    session = await ctx.newCDPSession(page);
  } catch (err) {
    // Non-Chromium engines throw here. The post-navigation chain assertion is
    // the remaining fence; say so once rather than failing every fetch.
    log.debug('browser request fence: CDP session unavailable, relying on the post-navigation chain check', {
      error: err instanceof Error ? err.message : String(err),
    });
    return INERT_GUARD;
  }

  let firstBlock: string | null = null;
  const resolvedCache = new Map<string, BrowserGuardVerdict>();

  session.on('Fetch.requestPaused', (ev) => {
    void (async () => {
      // The DECISION and the REPLY are separated deliberately. A rejected reply
      // (the page closed mid-flight, the request already gone) is a lifecycle
      // event, not a policy event — folding it into the same catch would let it
      // record a block reason and report a benign teardown as an SSRF refusal.
      let verdict: BrowserGuardVerdict;
      let requestUrl: string | undefined;
      try {
        // A missing resourceType is treated as a document: unknown means MORE
        // checking, never less. Read through a widened type so the
        // absent-field case stays expressible.
        const resourceType: string | undefined = ev.resourceType;
        requestUrl = ev.request?.url;
        const needsResolve = resourceType === undefined || resourceType === 'Document';
        verdict = await evaluateBrowserRequestUrl(requestUrl, {
          allowPrivate: opts.allowPrivate,
          resolve: needsResolve,
          resolvedCache,
          lookup: opts.lookup,
        });
      } catch (err) {
        // Fail CLOSED: an error deciding whether a request is safe is not a
        // reason to issue it. The page surfaces a navigation failure, which is
        // loud, instead of a silent allow.
        verdict = {
          allowed: false,
          reason: `browser request fence could not evaluate the target (${
            err instanceof Error ? err.message : String(err)
          })`,
        };
      }

      // Every paused request MUST be answered (continue or fail) or the page
      // hangs until the navigation timeout. Exactly one reply is sent here.
      if (verdict.allowed) {
        await session.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
        return;
      }
      if (firstBlock === null) firstBlock = verdict.reason;
      log.warn('browser tier refused a request to a blocked target', {
        url: requestUrl,
        reason: verdict.reason,
      });
      await session
        .send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' })
        .catch(() => {});
    })();
  });

  try {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  } catch (err) {
    // Deliberately NOT a throw. This runs before `fetchWithBrowser`'s
    // try/finally, so rejecting here would strand the page, the pooled context
    // slot and (on the stealth path) the throwaway browser — a CDP hiccup
    // would become a resource leak on every fetch. Degrade to the same posture
    // firefox/webkit are permanently in: no interceptor, and the
    // post-navigation chain assertion still refuses blocked content.
    log.warn('browser request fence could not enable interception; falling back to the post-navigation check', {
      error: err instanceof Error ? err.message : String(err),
    });
    await session.detach().catch(() => {});
    return INERT_GUARD;
  }

  return {
    intercepting: true,
    blockedReason: () => firstBlock,
    dispose: async () => {
      await session.detach().catch(() => {});
    },
  };
}

/**
 * Post-navigation backstop, run on EVERY engine. Re-guards the final URL and
 * every redirect hop that produced it, so blocked content is refused even where
 * no interceptor could refuse the request (firefox/webkit), or if the
 * interceptor were ever silently displaced.
 *
 * Literal-guard only: the hops have already been fetched, so a DNS lookup here
 * would answer a question about the future, not about what was retrieved.
 * Throws with the fence's own reason; fails closed on an absent chain entry.
 */
export function assertNavigationChainAllowed(
  chain: readonly (string | undefined | null)[],
  allowPrivate: boolean,
): void {
  for (const entry of chain) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('browser navigation produced a hop with no URL — refusing the result');
    }
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`browser navigation hop is unparseable (${entry.slice(0, 120)}) — refusing the result`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      if (HOSTLESS_SCHEMES.has(parsed.protocol)) continue;
      throw new Error(`browser navigation hop uses a forbidden protocol (${parsed.protocol})`);
    }
    const literal = guardFetchUrl(entry, 'browser navigation hop', { allowPrivate });
    if (!literal.ok) throw new Error(`${literal.reason}. ${literal.hint}`);
  }
}
