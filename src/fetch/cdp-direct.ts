import { createLogger } from '../logger.js';
import { discoverSessions } from './cdp-client.js';

const log = createLogger('fetch');

/**
 * Layer-B raw-CDP control plane — Phase 0 (DARK / not wired live).
 *
 * The keyless anti-bot cliff is the automation-protocol *handshake*: every
 * Playwright/Puppeteer fork (patchright included) issues `Runtime.enable` and
 * `Target.setAutoAttach` on connect, and enterprise WAFs fingerprint that shape.
 * This module owns the whole CDP channel, so it can attach and evaluate WITHOUT
 * ever sending those two commands — evaluation goes through an isolated world
 * (`Page.createIsolatedWorld` + a scoped `Runtime.evaluate`), never the
 * auto-enabled default Runtime domain.
 *
 * Content-fetch-only by design: navigate → read HTML → close. Actions, auth, and
 * downloads stay on the browser (patchright) tier. This build ships the
 * leak-free connect + unit tests only; the live escalation rung is gated on a
 * residential-IP GO/NO-GO the CEO runs later. Nothing here is imported by the
 * router or the browser pool.
 */

/** A single CDP command send. Injectable so tests can record every command. */
export type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/** The raw CDP transport this module drives. Owned by us end-to-end. */
export interface CdpTransport {
  send: CdpSend;
  close: () => Promise<void>;
}

/**
 * A `chrome-remote-interface`-shaped client. The real package returns an object
 * exposing `send(method, params)` and `close()`; we depend only on that surface.
 */
export interface CriClient {
  send: CdpSend;
  close: () => Promise<void> | void;
}

/**
 * Factory that opens a raw-CDP client against a page target. Mirrors the thin
 * subset of `chrome-remote-interface`'s `CDP({ target, ... })` we rely on.
 */
export type CriFactory = (opts: { target: string; local?: boolean }) => Promise<CriClient>;

/** The eval expression that reads the fully-hydrated document HTML. */
const CONTENT_EXPRESSION = 'document.documentElement.outerHTML';

/** Name of the isolated world we create for leak-free evaluation. */
const ISOLATED_WORLD_NAME = 'wigolo_cdp_direct';

// Module specifier held as a plain `string` (not a literal) so `tsc --noEmit`
// skips module resolution — `chrome-remote-interface` is an optionalDependency
// and may be absent on `npm install --omit=optional`. The dynamic import still
// throws at runtime when absent; we catch it and degrade to `null`.
const CRI_MODULE_ID: string = 'chrome-remote-interface';

interface CriModuleShape {
  default?: unknown;
}

let _criPromise: Promise<CriFactory | null> | null = null;
let _criCached: CriFactory | null = null;
let _criResolved = false;

/**
 * Test-only override for the optional-dep factory.
 * - `undefined` → use the real lazy import.
 * - `null` → force the "optional dep absent" fallback path.
 * - a factory → use that factory in place of the real package.
 */
let _testCriOverride: CriFactory | null | undefined;
export function _setCriForTests(factory: CriFactory | null | undefined): void {
  _testCriOverride = factory;
  _criPromise = null;
  _criCached = null;
  _criResolved = false;
}

/**
 * Resolve the optional `chrome-remote-interface` factory, or `null` when the
 * package is not installed. Never throws — an absent/broken optional package
 * resolves to `null` and the caller degrades gracefully. Memoized (a negative
 * result is cached too, so a missing package is probed only once).
 */
export async function loadCRI(): Promise<CriFactory | null> {
  if (_testCriOverride !== undefined) return _testCriOverride;
  if (_criResolved) return _criCached;
  if (_criPromise) return _criPromise;
  _criPromise = (async () => {
    try {
      const mod = (await import(CRI_MODULE_ID)) as CriModuleShape;
      const factory = (mod.default ?? mod) as unknown;
      if (typeof factory !== 'function') {
        log.debug('chrome-remote-interface present but no callable export; degrading');
        _criCached = null;
      } else {
        _criCached = factory as CriFactory;
        log.debug('raw-CDP control plane available (chrome-remote-interface)');
      }
    } catch {
      // Optional dep absent — silent, graceful fallback.
      log.debug('chrome-remote-interface not installed; raw-CDP rung unavailable');
      _criCached = null;
    }
    _criResolved = true;
    _criPromise = null;
    return _criCached;
  })();
  return _criPromise;
}

export interface CdpDirectConnectOptions {
  /**
   * A pre-built CDP transport. When provided, the optional dep is not touched —
   * primarily the test seam, but also lets a caller own the channel.
   */
  transport?: CdpTransport;
  /** Base CDP endpoint (e.g. `http://127.0.0.1:9222`) for target discovery. */
  cdpUrl?: string;
  /** A specific page target's WS debugger URL; skips discovery when set. */
  webSocketDebuggerUrl?: string;
  /** Abort signal — an already-aborted signal short-circuits to `null`. */
  signal?: AbortSignal;
  /** Discovery timeout in ms. */
  timeoutMs?: number;
}

/**
 * A content-fetch-only handle over the raw-CDP channel. Exposes just the
 * happy-path: navigate, read hydrated HTML, close. No actions/auth/downloads.
 */
export interface CdpDirectHandle {
  navigate(url: string): Promise<void>;
  getContentHtml(): Promise<string>;
  close(): Promise<void>;
}

interface IsolatedWorldResult {
  executionContextId?: number;
}

interface EvaluateResult {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: unknown;
}

interface NavigateResult {
  errorText?: string;
}

/**
 * Attach a leak-free raw-CDP control plane to a page target and return a
 * content-fetch handle, or `null` when no transport can be established
 * (optional dep absent, no discoverable page target, or an aborted signal).
 *
 * INVARIANT: the connect + eval sequence issues ZERO `Runtime.enable` and ZERO
 * `Target.setAutoAttach`. Evaluation runs in an isolated world created lazily on
 * first `getContentHtml`. This is the whole point of the rung — do not add a
 * `Runtime.enable` for convenience.
 */
export async function cdpDirectConnect(
  opts: CdpDirectConnectOptions,
): Promise<CdpDirectHandle | null> {
  if (opts.signal?.aborted) {
    log.debug('cdpDirectConnect: signal already aborted, not connecting');
    return null;
  }

  const transport = await resolveTransport(opts);
  if (!transport) return null;

  let closed = false;
  let isolatedContextId: number | undefined;
  let mainFrameId: string | undefined;

  const ensureIsolatedWorld = async (): Promise<number> => {
    if (isolatedContextId !== undefined) return isolatedContextId;
    // Isolated world in the main frame resolved from the prior navigation.
    // Evaluation here never touches the auto-enabled default Runtime domain.
    const res = (await transport.send('Page.createIsolatedWorld', {
      frameId: mainFrameId ?? '',
      worldName: ISOLATED_WORLD_NAME,
      grantUniversalAccess: false,
    })) as IsolatedWorldResult;
    if (typeof res?.executionContextId !== 'number') {
      throw new Error('cdp-direct: Page.createIsolatedWorld returned no executionContextId');
    }
    isolatedContextId = res.executionContextId;
    return isolatedContextId;
  };

  const handle: CdpDirectHandle = {
    async navigate(url: string): Promise<void> {
      if (closed) throw new Error('cdp-direct: handle is closed');
      if (opts.signal?.aborted) throw new Error('cdp-direct: aborted');
      const res = (await transport.send('Page.navigate', { url })) as NavigateResult & {
        frameId?: string;
      };
      if (res?.errorText) {
        throw new Error(`cdp-direct: navigation failed: ${res.errorText}`);
      }
      if (typeof res?.frameId === 'string') {
        mainFrameId = res.frameId;
      }
      // A fresh navigation invalidates any prior isolated world.
      isolatedContextId = undefined;
    },

    async getContentHtml(): Promise<string> {
      if (closed) throw new Error('cdp-direct: handle is closed');
      if (opts.signal?.aborted) throw new Error('cdp-direct: aborted');
      const contextId = await ensureIsolatedWorld();
      const res = (await transport.send('Runtime.evaluate', {
        expression: CONTENT_EXPRESSION,
        contextId,
        returnByValue: true,
        awaitPromise: false,
      })) as EvaluateResult;
      if (res?.exceptionDetails) {
        throw new Error('cdp-direct: content evaluation threw in isolated world');
      }
      const value = res?.result?.value;
      return typeof value === 'string' ? value : '';
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch (err) {
        log.debug('cdp-direct: transport close errored (ignored)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  return handle;
}

/**
 * Build the CDP transport for a connect: prefer an injected transport, else
 * open one via the optional `chrome-remote-interface` factory against a
 * discovered (or supplied) page target. Returns `null` on any unavailability.
 */
async function resolveTransport(
  opts: CdpDirectConnectOptions,
): Promise<CdpTransport | null> {
  if (opts.transport) return opts.transport;

  const factory = await loadCRI();
  if (!factory) return null;

  const targetWs = await resolveTargetWs(opts);
  if (!targetWs) {
    log.debug('cdp-direct: no page target discoverable, cannot connect');
    return null;
  }

  try {
    const client = await factory({ target: targetWs, local: true });
    return {
      send: (method, params) => client.send(method, params),
      close: async () => {
        await client.close();
      },
    };
  } catch (err) {
    log.debug('cdp-direct: raw-CDP attach failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Resolve the page target's WS debugger URL, discovering it if not supplied. */
async function resolveTargetWs(opts: CdpDirectConnectOptions): Promise<string | null> {
  if (opts.webSocketDebuggerUrl) return opts.webSocketDebuggerUrl;
  if (!opts.cdpUrl) return null;
  const sessions = await discoverSessions(opts.cdpUrl, {
    timeoutMs: opts.timeoutMs,
    filterPages: true,
  });
  const page = sessions.find((s) => s.webSocketDebuggerUrl);
  return page?.webSocketDebuggerUrl ?? null;
}
