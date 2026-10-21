import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp as fsMkdtemp, rm as fsRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { sanitizedChildEnv } from '../util/child-env.js';
import { stealthLaunchArgs } from './stealth.js';
import { discoverSessions, isCDPReachable } from './cdp-client.js';
import { classifyChallenge } from './challenge-classify.js';
import { guardFetchUrl, guardResolvedHost, type LookupAll } from '../watch/ssrf.js';
import type { RawFetchResult } from '../types.js';

const log = createLogger('fetch');

/**
 * Layer-B raw-CDP control plane — Phase 1 (opt-in escalation rung, OFF by default).
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
 * downloads stay on the browser (patchright) tier.
 *
 * `cdpDirectConnect` is the leak-free connect primitive (transport-agnostic,
 * unit-tested standalone). `cdpDirectFetch` productionizes it into a real
 * content-fetch rung: it launches a THROWAWAY real Chrome as a raw child process
 * (never `playwright.launch`, which would re-introduce the automation
 * control-plane handshake this rung exists to avoid) with a `--remote-debugging-port`,
 * connects raw, navigates, extracts HTML, and tears the child + temp profile down
 * ALWAYS. The rung is OFF by default (`config.cdpDirect === 'off'`) and wired into
 * the browser pool as an opt-in first-try on the anti-bot escalation path; on ANY
 * failure or absence it returns `null` so the caller falls back to the normal
 * browser tier — a fetch is NEVER hard-failed. This is an escalation rung for live
 * evaluation; it makes NO claim to beat the existing patchright + channel=chrome tier.
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

/** Reads where the page ACTUALLY landed. `Page.navigate` follows redirects
 *  inside the browser, so the requested URL is not necessarily the one whose
 *  content we are about to read. */
const LOCATION_EXPRESSION = 'location.href';

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
  /** Where the page actually landed after any in-browser redirects, or '' when
   *  it cannot be read. Never throws. */
  getLocationHref?(): Promise<string>;
  close(): Promise<void>;
  /** Best-effort: send the browser window to the background (minimized) so a
   *  HEADFUL render never steals the user's screen. Resolves even when the
   *  browser refuses — backgrounding is cosmetic, never load-bearing. */
  minimizeWindow?(): Promise<void>;
  /** The user agent the launched binary reports for itself, or null. */
  browserUserAgent?(): Promise<string | null>;
  /** Present a coherent headless identity (UA + client hints + dpr) so the HTTP
   *  and JS surface match the same binary running headful. Best-effort. */
  applyIdentity?(identity: CoherentIdentity, viewport: { width: number; height: number }): Promise<void>;
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
    // Background the HEADFUL window. Headful is REQUIRED to clear real bot walls
    // (headless is itself the tell — measured: same IP, headless blocked, headful
    // passed), but a window popping onto the user's screen is unacceptable for a
    // background fetch. Minimizing keeps the real-browser signals while getting
    // out of the way; `document.visibilityState` becomes 'hidden', which walls do
    // NOT appear to score (verified passing while minimized). Paired with the
    // anti-throttle launch flags so the hidden window's timers/rAF still run at
    // full speed — otherwise a challenge's own polling JS gets throttled and
    // stalls. Entirely best-effort: any failure is swallowed.
    async minimizeWindow(): Promise<void> {
      if (closed) return;
      try {
        const win = (await transport.send('Browser.getWindowForTarget', {})) as { windowId?: number };
        if (typeof win?.windowId !== 'number') return;
        await transport.send('Browser.setWindowBounds', {
          windowId: win.windowId,
          bounds: { windowState: 'minimized' },
        });
      } catch {
        /* cosmetic only — never fail a fetch because the window stayed visible */
      }
    },
    async browserUserAgent(): Promise<string | null> {
      try {
        const v = (await transport.send('Browser.getVersion', {})) as { userAgent?: string };
        return typeof v?.userAgent === 'string' && v.userAgent ? v.userAgent : null;
      } catch {
        return null;
      }
    },
    async applyIdentity(identity, viewport): Promise<void> {
      try {
        await transport.send('Network.enable', {});
        // UA, platform and client-hint metadata are set in ONE call so they can
        // never disagree with each other.
        await transport.send('Network.setUserAgentOverride', {
          userAgent: identity.userAgent,
          platform: identity.platform,
          userAgentMetadata: identity.userAgentMetadata,
          // acceptLanguage is deliberately NOT sent here: supplying it relocates
          // the Accept-Language header out of its natural last position, which is
          // an ordering anomaly no real Chrome produces. The launch flags set the
          // language instead.
        });
        await transport.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: identity.deviceScaleFactor,
          mobile: false,
        });
      } catch {
        /* best-effort: a fetch must never fail because hardening didn't apply */
      }
    },
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

    async getLocationHref(): Promise<string> {
      if (closed) return '';
      try {
        const contextId = await ensureIsolatedWorld();
        const res = (await transport.send('Runtime.evaluate', {
          expression: LOCATION_EXPRESSION,
          contextId,
          returnByValue: true,
          awaitPromise: false,
        })) as EvaluateResult;
        const value = res?.result?.value;
        return typeof value === 'string' ? value : '';
      } catch {
        // Best-effort: an unreadable location falls back to the requested URL,
        // which the caller has already guarded.
        return '';
      }
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

/** Max wall-clock to wait for a spawned Chrome's first page target to register.
 *  Chrome exposes the HTTP debug port BEFORE the initial page target appears
 *  (~1-2s gap on Chrome 150); a single-shot discover races that gap, so the
 *  rung must poll. */
const TARGET_DISCOVER_MS = 6000;
const TARGET_POLL_INTERVAL_MS = 250;

/**
 * Poll for a page target's WS debugger URL until one appears or the deadline
 * elapses. `discover`/`sleep`/`now` are injected for deterministic tests.
 * Returns the first page target's WS URL, or null when none registers within
 * the budget / the signal aborts.
 */
export async function discoverPageTargetWithRetry(deps: {
  discover: () => Promise<Array<{ webSocketDebuggerUrl?: string }>>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadlineMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const deadline = deps.now() + (deps.deadlineMs ?? TARGET_DISCOVER_MS);
  const interval = deps.intervalMs ?? TARGET_POLL_INTERVAL_MS;
  for (;;) {
    if (deps.signal?.aborted) return null;
    const sessions = await deps.discover();
    const target = sessions.find((s) => s.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
    if (target) return target;
    if (deps.now() >= deadline) return null;
    await deps.sleep(interval);
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

// ---------------------------------------------------------------------------
// cdpDirectFetch — spawn a throwaway real Chrome + drive the leak-free rung
// ---------------------------------------------------------------------------

/** Options accepted by the productionized content-fetch rung. */
export interface CdpDirectFetchOptions {
  /** Abort signal — an already-aborted signal short-circuits to `null`. */
  signal?: AbortSignal;
  /** Total wall-clock budget (ms) for the whole rung: spawn → reachable →
   *  navigate → read → teardown. Defaults to a bounded value. */
  timeoutMs?: number;
  /** Injectable DNS lookup for the pre-navigation resolved-host SSRF re-check
   *  (tests). Defaults to Node's `dns.lookup`. */
  lookup?: LookupAll;
}

/**
 * Injectable dependency seam for {@link cdpDirectFetch}. Every side effect the
 * rung performs (resolve Chrome, spawn a child, probe the debug endpoint,
 * mkdtemp / rm the throwaway profile, open the CDP transport) is behind this so
 * a unit test drives the whole orchestration with NO real Chrome or network.
 * Left `undefined` in production → the real implementations are used.
 */
export interface CdpDirectFetchDeps {
  /** Resolve a real installed Chrome executable path, or `null` when none. */
  resolveChrome: () => string | null;
  /** Spawn the browser child process (raw — never playwright.launch). Spawned
   *  `detached` so the whole process group can be killed on teardown, not just
   *  the Chrome parent (renderer / GPU children can otherwise orphan). */
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: 'ignore'; detached: boolean }) => ChildProcess;
  /** Probe whether the CDP debug endpoint is reachable. */
  isReachable: (cdpUrl: string, timeoutMs?: number) => Promise<boolean>;
  /** Create a throwaway user-data dir from a prefix; returns the created path. */
  mkdtemp: (prefix: string) => Promise<string>;
  /** Remove the throwaway user-data dir (recursive, force). */
  rm: (dir: string) => Promise<void>;
  /** Open a CDP transport against the launched browser's debug endpoint, or
   *  `null` when the optional dep is absent / no page target is discoverable. */
  connectTransport: (cdpUrl: string, signal?: AbortSignal) => Promise<CdpTransport | null>;
}

let _testFetchDeps: CdpDirectFetchDeps | undefined;
/** Test-only override for the fetch dependency seam. `undefined` → real deps. */
export function _setCdpDirectFetchDepsForTests(deps: CdpDirectFetchDeps | undefined): void {
  _testFetchDeps = deps;
}

/** Process-group signaller. Real `process.kill`, overridable in tests so the
 *  group-kill path can be asserted without signalling a real process group. */
type GroupKill = (pid: number, signal: NodeJS.Signals | number) => void;
let _testProcessKill: GroupKill | undefined;
export function _setProcessKillForTests(fn: GroupKill | undefined): void {
  _testProcessKill = fn;
}

// Total-budget default when the caller passes none. Bounded so a stuck launch /
// challenge never holds the escalation slot; the caller's own signal is the
// harder ceiling when present.
const DEFAULT_FETCH_BUDGET_MS = 30_000;
// How long to wait for the debug endpoint to come up after spawn.
const REACHABLE_TIMEOUT_MS = 8_000;
const REACHABLE_POLL_MS = 150;
// Settle after navigation before reading HTML. Short — the rung is a content
// fetch, not an interaction session; a slow SPA simply reads less and the
// caller falls back on an empty/near-empty body.
const NAV_SETTLE_MS = 1_200;
/** Upper bound on the post-navigation challenge-clear poll. A bot-wall
 *  interstitial that auto-clears (PerimeterX/Cloudflare) typically does so
 *  within a few seconds; past this we fall back rather than hold the rung. */
const CHALLENGE_CLEAR_TIMEOUT_MS = 12_000;
const CHALLENGE_POLL_INTERVAL_MS = 500;

/**
 * Keep a BACKGROUNDED (minimized/occluded) window's timers running at full
 * speed. Chromium throttles background renderers — `requestAnimationFrame`
 * callbacks get skipped and timers slowed — which stalls a challenge page's own
 * polling JS and makes it look like the challenge never clears. Every browser
 * automation framework ships these for the same reason. Note Chromium labels the
 * first one a testing switch internally, so treat it as best-effort, not API.
 */
const ANTI_THROTTLE_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
];

/**
 * Whether a window server / display is reachable, i.e. whether a HEADFUL Chrome
 * can actually launch. Headful is required to clear real bot walls (headless is
 * the tell), so we prefer it whenever a display exists and only fall back to
 * headless — with the honest ceiling that implies — when there is none (a bare
 * Linux server with no X/Wayland session and no virtual display).
 */
/** The identity override a headless browser must present so its HTTP + JS
 *  surface matches what the SAME binary sends when headful. */
export interface CoherentIdentity {
  userAgent: string;
  platform: string;
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>;
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
  deviceScaleFactor: number;
}

/**
 * Derive a coherent identity from the launched binary's OWN reported user agent
 * (`Browser.getVersion`), so nothing is invented and nothing can drift.
 *
 * Headless Chrome differs from headful in exactly three ways that reach a
 * server, and they must be fixed TOGETHER — fixing one alone creates a worse
 * signal than the original, because detectors score cross-layer contradictions
 * rather than individual values:
 *   1. the UA carries a `HeadlessChrome` token,
 *   2. the UA carries the full build (`150.0.7871.187`) where headful sends a
 *      reduced `150.0.0.0`, and the `sec-ch-ua` brand list names HeadlessChrome,
 *   3. `devicePixelRatio` reports 1 even on a HiDPI host — implausible next to a
 *      real GPU renderer string (measured: headful 2, headless 1 on the same Mac).
 *
 * Everything else (header order, casing, Accept-Encoding, Sec-Fetch-*, HTTP/2
 * SETTINGS and pseudo-header order) is already byte-identical between the two
 * modes, so it is deliberately left alone.
 *
 * The brand list is rebuilt from the SAME major the UA reports, so UA major,
 * brand major and fullVersion major can never disagree.
 */
export function coherentIdentity(rawUserAgent: string, platform: NodeJS.Platform): CoherentIdentity | null {
  const deHeadless = rawUserAgent.replace(/HeadlessChrome/g, 'Chrome');
  const m = deHeadless.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const major = m[1];
  const fullVersion = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  // Headful Chrome sends a REDUCED UA version (major.0.0.0); headless leaks the
  // full build. Match headful.
  const userAgent = deHeadless.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${major}.0.0.0`);
  const uaPlatform = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  return {
    userAgent,
    platform: platform === 'darwin' ? 'MacIntel' : platform === 'win32' ? 'Win32' : 'Linux x86_64',
    userAgentMetadata: {
      // A GREASE entry plus the two real brands, all on the UA's own major.
      brands: [
        { brand: 'Not;A=Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ],
      fullVersion,
      platform: uaPlatform,
      platformVersion: '',
      architecture: process.arch.startsWith('arm') ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
    // HiDPI is the norm on Mac; 1 is the norm on a Linux server. A HiDPI GPU
    // renderer reporting dpr 1 is the contradiction we are removing.
    deviceScaleFactor: platform === 'darwin' ? 2 : 1,
  };
}

function hasDisplaySession(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
// Grace after SIGTERM before escalating to SIGKILL on teardown.
const KILL_GRACE_MS = 2_000;

/**
 * Real Chrome executable resolver. Prefers an explicit env override, else probes
 * the well-known per-platform install locations for an AUTHENTIC Chrome (never
 * the bundled "Chrome for Testing", whose fingerprint is exactly what this rung
 * exists to avoid). Returns `null` when no installed Chrome is found OR when the
 * user pinned `browserChannel: 'chromium'` (an explicit opt-out of authentic
 * Chrome) — either way the caller degrades to the normal browser tier.
 */
function defaultResolveChrome(): string | null {
  const cfg = getConfig();
  // Respect an explicit chromium pin: the whole rung is about real Chrome.
  if (cfg.browserChannel === 'chromium') return null;

  const override = process.env.WIGOLO_CHROME_PATH || process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;

  const candidates: string[] =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/opt/google/chrome/chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ];

  for (const path of candidates) {
    try {
      if (path && existsSync(path)) return path;
    } catch { /* keep probing */ }
  }
  return null;
}

/** Reserve a free localhost TCP port, then release it. Best-effort: a returned
 *  port could in theory be reclaimed before Chrome binds it, but for a throwaway
 *  child this is acceptable and far simpler than DevToolsActivePort parsing. */
async function reserveFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Open a real CDP transport against a launched browser's HTTP debug endpoint by
 *  discovering a page target and connecting via the optional CRI factory. This is
 *  the production `connectTransport` — tests inject their own. */
async function defaultConnectTransport(
  cdpUrl: string,
  signal?: AbortSignal,
): Promise<CdpTransport | null> {
  // Reuse cdpDirectConnect's transport builder by discovering the WS target
  // ourselves so we can hand a concrete transport to cdpDirectConnect below.
  const factory = await loadCRI();
  if (!factory) return null;
  // Poll for the first page target — Chrome opens the debug port before the
  // page target registers, so a single-shot discover races the gap and finds
  // nothing (root-caused live 2026-07-27). Bounded + abort-aware.
  const target = await discoverPageTargetWithRetry({
    discover: () => discoverSessions(cdpUrl, { timeoutMs: 3000, filterPages: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    signal,
  });
  if (!target) return null;
  try {
    const client = await factory({ target, local: true });
    return {
      send: (method, params) => client.send(method, params),
      close: async () => { await client.close(); },
    };
  } catch (err) {
    log.debug('cdp-direct: transport connect failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function realFetchDeps(): CdpDirectFetchDeps {
  return {
    resolveChrome: defaultResolveChrome,
    spawn: (command, args, options) => nodeSpawn(command, args, options),
    // detached: true so killChild can signal the whole process group (-pid),
    // reaping reparented renderer/GPU children Chrome forks.
    isReachable: isCDPReachable,
    mkdtemp: (prefix) => fsMkdtemp(prefix),
    rm: async (dir) => { await fsRm(dir, { recursive: true, force: true }); },
    connectTransport: defaultConnectTransport,
  };
}

/**
 * Signal a spawned child's whole PROCESS GROUP (child spawned `detached`, so its
 * group id is its own pid). Killing the group reaps reparented renderer / GPU
 * children Chrome forks — killing the parent pid alone can orphan them. Falls
 * back to a plain `child.kill(signal)` when the group kill throws (e.g. the group
 * is already dead, or `process.kill` is unavailable in a fake). Never throws.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  const killFn: GroupKill = _testProcessKill ?? ((p, s) => process.kill(p, s));
  if (typeof pid === 'number' && pid > 0) {
    try {
      killFn(-pid, signal);
      return;
    } catch {
      // Group kill failed (already dead / no group) — fall through to the parent.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Kill a spawned child's process group and wait (bounded) for it to exit;
 *  escalate SIGTERM → SIGKILL after a short grace. Never throws. */
async function killChild(child: ChildProcess): Promise<void> {
  // Already exited? (a number exit code or a real signal). `null`/`undefined`
  // both mean "still running" — undefined arises for injected fakes.
  if (typeof child.exitCode === 'number' || (child.signalCode != null)) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  signalGroup(child, 'SIGTERM');
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, KILL_GRACE_MS);
    (graceTimer as { unref?: () => void }).unref?.();
  });
  const winner = await Promise.race([exited.then(() => 'exited' as const), grace.then(() => 'grace' as const)]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  if (winner === 'grace') {
    signalGroup(child, 'SIGKILL');
  }
}

/** True when `host` is an IP literal — already covered by the upstream literal
 *  SSRF guard (tools/fetch.ts), so a DNS-resolved re-check would be redundant.
 *  Mirrors escape-hatch's helper of the same name. */
function isIpLiteralHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Pre-navigation SSRF re-check for the cdp-direct rung. The upstream fetch path
 * (tools/fetch.ts) only validates the LITERAL host, so a public hostname whose
 * DNS record points at cloud metadata (169.254.169.254) / RFC-1918 / loopback
 * passes that guard and would reach an internal service through this rung — a
 * new unguarded egress. This resolves the target host and blocks a rebind BEFORE
 * `handle.navigate`. Returns `true` when allowed (or skipped for an IP literal),
 * `false` when the resolved address is blocked. Honours the SAME
 * `fetchAllowPrivate` policy the rest of the fetch path uses.
 */
/**
 * The `--proxy-server` argument this rung must launch with so it egresses the
 * SAME way as every other tier, or a refusal.
 *
 * This rung spawns its own browser, so unlike the Playwright tiers it does not
 * inherit the configured proxy for free — and its env is proxy-stripped. Left
 * unwired it egressed DIRECT on the operator's real IP whenever a proxy was
 * configured, silently defeating the boundary they set up.
 *
 * Chrome's `--proxy-server` accepts NO inline credentials, so an authenticated
 * proxy cannot be honoured here at all. Rather than fall back to direct (the
 * exact leak), the rung REFUSES: `{ refuse: true }` makes the caller return null
 * and the fetch degrades to the normal browser tier, which does honour it.
 */
function proxyArgFor(cfg: { useProxy: boolean; proxyUrl: string | null }):
  | { refuse: true }
  | { refuse: false; arg: string | null } {
  if (!cfg.useProxy || !cfg.proxyUrl) return { refuse: false, arg: null };
  let parsed: URL;
  try {
    parsed = new URL(cfg.proxyUrl);
  } catch {
    // An unparseable proxy URL cannot be honoured — refuse rather than leak.
    return { refuse: true };
  }
  if (parsed.username || parsed.password) return { refuse: true };
  // Rebuild from parts so nothing beyond scheme/host/port reaches the flag.
  const port = parsed.port ? `:${parsed.port}` : '';
  return { refuse: false, arg: `--proxy-server=${parsed.protocol}//${parsed.hostname}${port}` };
}

/** True when `value` parses as an http(s) URL. Used to decide whether a
 *  `location.href` read is trustworthy enough to act on. */
function isHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const p = new URL(value);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Guard a POST-REDIRECT landing URL. Unlike the pre-navigation check this must
 * NOT skip IP literals: that skip is justified only because the caller's literal
 * guard already vetted the REQUESTED url, and a redirect target was never seen
 * by it. `http://169.254.169.254/` is exactly the shape a rebind lands on, so it
 * gets the literal guard here plus the resolved check for hostnames.
 */
async function landingGuardOk(url: string, lookup?: LookupAll): Promise<boolean> {
  const literal = guardFetchUrl(url, 'cdp-direct redirect target');
  if (!literal.ok) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (isIpLiteralHost(host)) return true; // already vetted by guardFetchUrl above
  const allowPrivate = getConfig().fetchAllowPrivate;
  const resolved = await guardResolvedHost(host, 'cdp-direct redirect target', { allowPrivate, lookup });
  return resolved.ok;
}

async function resolvedNavigateGuardOk(url: string, lookup?: LookupAll): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Unparseable URL — refuse rather than navigate to something we can't guard.
    return false;
  }
  if (isIpLiteralHost(host)) return true;
  const allowPrivate = getConfig().fetchAllowPrivate;
  const resolved = await guardResolvedHost(host, 'cdp-direct target URL', { allowPrivate, lookup });
  return resolved.ok;
}

/** Wait until the CDP debug endpoint is reachable, bounded by `deadline` and the
 *  abort signal. Returns true when reachable, false on timeout/abort. */
async function waitForReachable(
  isReachable: CdpDirectFetchDeps['isReachable'],
  cdpUrl: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) return false;
    const remaining = deadlineMs - Date.now();
    if (await isReachable(cdpUrl, Math.min(1000, remaining)).catch(() => false)) return true;
    if (signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, REACHABLE_POLL_MS));
  }
  return false;
}

/**
 * Launch a throwaway real Chrome as a RAW child process, connect over raw CDP,
 * navigate, extract the hydrated HTML, and tear everything down. Returns a
 * `RawFetchResult` on success, or `null` on ANY failure/absence so the caller
 * falls back to the normal browser tier. NEVER throws to the caller.
 *
 * Content-fetch-only: the caller must NOT route actions/auth/downloads/screenshots
 * or a pinned cdpUrl here — those stay on the normal tier.
 */
export async function cdpDirectFetch(
  url: string,
  opts: CdpDirectFetchOptions = {},
): Promise<RawFetchResult | null> {
  if (opts.signal?.aborted) {
    log.debug('cdp-direct: signal already aborted, not launching');
    return null;
  }

  const deps = _testFetchDeps ?? realFetchDeps();

  const chromePath = deps.resolveChrome();
  if (!chromePath) {
    log.debug('cdp-direct: no authentic Chrome resolvable, falling back');
    return null;
  }

  const budgetMs = opts.timeoutMs ?? DEFAULT_FETCH_BUDGET_MS;
  const startedAt = Date.now();

  let userDataDir: string | null = null;
  let child: ChildProcess | null = null;
  let handle: CdpDirectHandle | null = null;

  try {
    userDataDir = await deps.mkdtemp(join(tmpdir(), 'wigolo-cdp-direct-'));

    const port = await reserveFreePort();
    const cfg = getConfig();

    // Egress policy FIRST: this rung owns its own browser process, so it only
    // honours the operator's proxy if we hand it one explicitly.
    const proxyDecision = proxyArgFor(cfg);
    if (proxyDecision.refuse) {
      log.info(
        'cdp-direct declined: the configured proxy cannot be applied to this rung, and egressing direct would bypass it',
        { url },
      );
      return null;
    }
    // Prefer HEADFUL whenever a display exists — headless is itself the strongest
    // automation tell on real bot walls (measured on one residential IP: the same
    // Chrome passed zillow/indeed headful and was blocked with --headless=new).
    // When the operator has not asked for a visible window we still launch
    // headful and MINIMIZE it after connect (see minimizeWindow), so the wall
    // sees a real browser while the user's screen stays untouched. Only a
    // display-less host falls back to headless, with the honest ceiling that
    // implies (a virtual display, e.g. Xvfb, restores the headful path there).
    // `browserWindowless` forces the headless path even where a display exists,
    // for callers that must guarantee no browser window is ever created (the
    // coherent-identity override below is what makes that viable).
    const displayAvailable = hasDisplaySession() && !cfg.browserWindowless;
    const headless = !displayAvailable;
    const backgroundWindow = displayAvailable && !cfg.browserHeadful;
    const args = [
      ...ANTI_THROTTLE_ARGS,
      // Headless Chrome omits Accept-Language ENTIRELY where headful sends
      // `en-US,en;q=0.9`. Set it at launch (not via CDP) so the header keeps its
      // natural last position — supplying it through the UA override relocates it
      // and creates a fresh ordering anomaly.
      '--accept-lang=en-US,en;q=0.9',
      ...stealthLaunchArgs('chromium'),
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // NB: do NOT pass --no-startup-window. On Chrome 129+ it suppresses the
      // initial `page` target entirely (only extension background_page/
      // service_worker targets remain), so the page-target discovery finds
      // nothing and the rung silently falls back on every spawn (root-caused
      // live 2026-07-27). The initial `about:blank` page is what we navigate.
      ...(headless ? ['--headless=new'] : []),
      // Route through the operator's proxy when one is configured, so this rung
      // egresses the same way every other tier does.
      ...(proxyDecision.arg ? [proxyDecision.arg] : []),
      'about:blank',
    ];

    child = deps.spawn(chromePath, args, {
      env: sanitizedChildEnv({ stripProxy: true }),
      stdio: 'ignore',
      // Own process group so teardown can kill the whole group (renderer/GPU
      // children reparent under Chrome and would otherwise orphan).
      detached: true,
    });
    // A child that dies immediately (bad binary) must not leave a dangling
    // error listener; swallow so it never becomes an unhandled 'error'.
    child.on('error', (err) => {
      log.debug('cdp-direct: child process error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (opts.signal?.aborted) return null;

    const cdpUrl = `http://127.0.0.1:${port}`;
    const reachDeadline = Math.min(startedAt + budgetMs, Date.now() + REACHABLE_TIMEOUT_MS);
    const reachable = await waitForReachable(deps.isReachable, cdpUrl, reachDeadline, opts.signal);
    if (!reachable) {
      log.debug('cdp-direct: debug endpoint never became reachable, falling back', { url });
      return null;
    }
    if (opts.signal?.aborted) return null;

    const transport = await deps.connectTransport(cdpUrl, opts.signal);
    if (!transport) {
      log.debug('cdp-direct: no CDP transport (optional dep / no target), falling back', { url });
      return null;
    }

    handle = await cdpDirectConnect({ transport, signal: opts.signal });
    if (!handle) return null;

    // Send the headful window to the background BEFORE navigating, so the user
    // never sees it flash up mid-fetch. Best-effort by contract.
    if (backgroundWindow) await handle.minimizeWindow?.();

    // Headless leaks a `HeadlessChrome` UA token, a HeadlessChrome sec-ch-ua
    // brand, the full build version, and dpr 1 on a HiDPI host. Present the
    // coherent identity of the same binary running headful instead — derived
    // from the binary's OWN reported UA so nothing drifts. Headful needs none of
    // this: its identity is already correct, and overriding it could only
    // introduce a contradiction.
    if (headless) {
      const rawUa = await handle.browserUserAgent?.();
      const identity = rawUa ? coherentIdentity(rawUa, process.platform) : null;
      if (identity) {
        await handle.applyIdentity?.(identity, { width: 1200, height: 900 });
        log.debug('cdp-direct: applied coherent headless identity', {
          chromeMajor: identity.userAgentMetadata.brands.find((b) => b.brand === 'Chromium')?.version,
          dpr: identity.deviceScaleFactor,
        });
      }
    }

    // SSRF: re-check the RESOLVED host before we navigate. The upstream literal
    // guard cannot catch a DNS rebind to metadata / RFC-1918 / loopback, and this
    // rung navigates before the browser tier's pre-navigation re-check. Block
    // here → return null (caller falls back / the fetch is refused), NO egress.
    if (!(await resolvedNavigateGuardOk(url, opts.lookup))) {
      log.debug('cdp-direct: resolved-host SSRF guard blocked navigate, refusing', { url });
      return null;
    }

    await handle.navigate(url);
    if (opts.signal?.aborted) return null;

    // Bounded settle before the content read. Race against the abort signal so a
    // cancelled fetch tears down promptly.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, NAV_SETTLE_MS);
      (t as { unref?: () => void }).unref?.();
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (opts.signal?.aborted) return null;

    // Read + CHALLENGE-CLEAR POLL.
    //
    // Two problems are solved together here:
    //   1. cdp-direct has no real HTTP status (it navigates and reads the DOM),
    //      so a bot wall that serves its denial/challenge page at HTTP 200
    //      (PerimeterX "Access denied", Cloudflare/DataDome interstitials) would
    //      otherwise be returned as SUCCESSFUL content.
    //   2. Those interstitials commonly auto-clear a couple of seconds after
    //      navigation. A single read at NAV_SETTLE_MS catches the interstitial
    //      and would wrongly fall back on a page that was about to render.
    //
    // So: re-read until the body is no longer a challenge (→ real content) or
    // the bounded deadline elapses (→ null, caller falls back to the standard
    // tier, which maps to an honest blocked_by_challenge). Mirrors the browser
    // tier's pollUntilCleared. Live-found 2026-07-28: zillow's PerimeterX
    // interstitial cleared at ~3s while the fixed 1.2s settle read the wall.
    const clearDeadline = Math.min(startedAt + budgetMs, Date.now() + CHALLENGE_CLEAR_TIMEOUT_MS);
    let html = '';
    for (;;) {
      if (opts.signal?.aborted) return null;
      html = await handle.getContentHtml();
      if (html && classifyChallenge(html) === 'none') break;
      if (Date.now() >= clearDeadline) {
        log.debug('cdp-direct: challenge/empty body did not clear, falling back', {
          url,
          challengeClass: html ? classifyChallenge(html) : 'empty',
        });
        return null;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CHALLENGE_POLL_INTERVAL_MS);
        (t as { unref?: () => void }).unref?.();
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }

    // POST-REDIRECT SSRF re-check. The pre-navigation guard covers the
    // REQUESTED host only; `Page.navigate` follows redirects inside the browser,
    // so a public host that 302s to cloud metadata / RFC-1918 / loopback lands
    // somewhere the guard never saw. Read where we actually ended up and refuse
    // to hand back its content.
    //
    // Honest limit: this blocks the RESULT, not the request. The redirect hop
    // itself has already left the machine by the time we can read `location`.
    // Guarding every hop needs request interception, which would mean enabling
    // another CDP domain on the one rung that exists to keep its protocol
    // surface minimal — so the exfiltration path is closed here and the
    // connection-level exposure is stated rather than hidden.
    // Only trust a landing value that is actually an http(s) URL. An empty or
    // unparseable read (a stub, a closed page, a `data:`/`about:` shell) must
    // fall back to the requested URL — which is already guarded — rather than
    // fail the fetch on an unreadable value.
    const landed = (await handle.getLocationHref?.()) ?? '';
    const finalUrl = isHttpUrl(landed) ? landed : url;
    if (finalUrl !== url && !(await landingGuardOk(finalUrl, opts.lookup))) {
      log.warn('cdp-direct: page redirected to a blocked address, refusing to return its content', {
        url,
        finalUrl,
      });
      return null;
    }

    log.info('cdp-direct rung produced content', { url, bytes: html.length });
    return {
      url,
      finalUrl,
      html,
      contentType: 'text/html',
      statusCode: 200,
      method: 'browser',
      headers: {},
    };
  } catch (err) {
    // NEVER throw to the caller — any failure degrades to a fallback.
    log.debug('cdp-direct: rung failed, falling back', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    // Teardown ALWAYS: close the CDP session, kill the child, remove the temp dir.
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (child) {
      await killChild(child).catch(() => {});
    }
    if (userDataDir) {
      await deps.rm(userDataDir).catch((err) => {
        log.debug('cdp-direct: temp dir cleanup failed (ignored)', {
          dir: userDataDir,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}
