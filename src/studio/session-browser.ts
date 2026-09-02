import type { BrowserContext, BrowserContextOptions } from 'playwright';
import { requireBrowserDriver } from '../fetch/browser-driver.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

/**
 * Slice 5d — the storageState to LOAD into a session context (a profile blob the host resolved, or
 * undefined for a clean session). Mirrors Playwright's newContext storageState input.
 */
export type StorageStateInput = BrowserContextOptions['storageState'];
/** Slice 5d — the storageState READ BACK from a live context (5e capture-after-login). Host-only. */
export type StorageStateOut = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * The live, headed, isolated browser bound to a Studio session — the thing the
 * human and (in Phase 2) the agent co-drive. It is a NEW dedicated context with
 * its own launch path, deliberately separate from the headless fetch pool
 * (`MultiBrowserPool` is `headless:true`-hardcoded and shares a wait queue): a
 * session must not share state with fetches or other sessions. CDP for
 * screencast / input / overlay comes from `context.newCDPSession(page)` —
 * net-new work, not the discovery-only `cdp-client.ts`.
 *
 * The browser handles are reached through narrow structural interfaces so the
 * lifecycle is unit-testable with a fake launcher; the real Playwright launcher
 * is adapted at exactly one boundary (`defaultSessionLauncher`).
 */

const log = createLogger('studio');

export interface SessionPage {
  close(): Promise<void>;
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<unknown>;
  on(event: 'crash', cb: () => void): void;
  /** The live main-frame URL (Playwright Page.url()) — the host-observed hard signal the 6c risk gate reads. */
  url(): string;
  /**
   * #318 — the three page methods the ONE shared quiescence wait (`fetch/settle.ts`) needs. OPTIONAL
   * because this is a narrow structural view of a real browser-engine page: every fake launcher in the
   * unit harness omits them, and a host that cannot settle must degrade to "snapshot immediately"
   * (a delta, not a SETTLED delta — a smaller claim, never a wrong one) rather than throw.
   * `settlablePage()` below is the ONE place the presence check lives.
   */
  waitForLoadState?(state: 'networkidle', opts: { timeout: number }): Promise<unknown>;
  waitForFunction?(src: string, arg: undefined, opts: { timeout: number }): Promise<unknown>;
  evaluate?(src: string): Promise<unknown>;
}

/** The all-three-present shape `settlePage()` accepts. Structural — settle.ts keeps its handle type private. */
export interface SettlablePage {
  waitForLoadState(state: 'networkidle', opts: { timeout: number }): Promise<unknown>;
  waitForFunction(src: string, arg: undefined, opts: { timeout: number }): Promise<unknown>;
  evaluate(src: string): Promise<unknown>;
}

/**
 * Narrow a session page to the settle handle, or null when the page cannot be settled (a fake, or a
 * future engine that lacks one of the three). Callers branch on null; they never feature-test inline.
 */
export function settlablePage(page: SessionPage): SettlablePage | null {
  const { waitForLoadState, waitForFunction, evaluate } = page;
  if (!waitForLoadState || !waitForFunction || !evaluate) return null;
  return {
    waitForLoadState: (state, opts) => waitForLoadState.call(page, state, opts),
    waitForFunction: (src, arg, opts) => waitForFunction.call(page, src, arg, opts),
    evaluate: (src) => evaluate.call(page, src),
  };
}

export interface SessionCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, cb: (payload: never) => void): void;
  off(event: string, cb: (payload: never) => void): void;
}

export interface LaunchedSessionBrowser {
  browser: { close(): Promise<void>; on(event: 'disconnected', cb: () => void): void };
  /** `storageState()` is the HOST-ONLY read-back accessor for 5e capture-after-login — never agent-reachable, never logged. */
  context: { close(): Promise<void>; storageState(): Promise<StorageStateOut> };
  page: SessionPage;
  cdp: SessionCdp;
}

export interface LaunchOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  /** Slice 5d: an opted-in named profile's storageState to load into the context. Undefined ⇒ clean session. Host-resolved; never logged. */
  storageState?: StorageStateInput;
}

export type SessionBrowserLauncher = (opts: LaunchOptions) => Promise<LaunchedSessionBrowser>;

/** The real launcher: dedicated headed Chromium → isolated context → page → CDP session. */
export async function defaultSessionLauncher(opts: LaunchOptions): Promise<LaunchedSessionBrowser> {
  const browser = await (await requireBrowserDriver()).chromium.launch({ headless: opts.headless });
  // deviceScaleFactor:1 keeps screencast frame coords 1:1 with the CSS viewport for input
  // mapping (Phase 1c). Slice 5d: an opted-in named profile loads its storageState here (the
  // browser scopes the cookies by origin naturally — origin-scoping at PERSIST is 5e's job);
  // absent ⇒ a clean ephemeral profile.
  const context = await browser.newContext({
    viewport: opts.viewport,
    deviceScaleFactor: 1,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  // Adapt Playwright's precisely-typed handles to the narrow session interfaces
  // at this single boundary (the CDPSession.send overloads are not structurally
  // assignable to a generic send()).
  return { browser, context, page, cdp } as unknown as LaunchedSessionBrowser;
}

export interface SessionBrowserOptions {
  sessionId: string;
  /** Injectable for tests; defaults to the real Playwright launcher. */
  launch?: SessionBrowserLauncher;
  /** Max relaunch attempts before giving up; defaults to config.studioBrowserCrashMaxRestarts. */
  maxRestarts?: number;
  /**
   * Slice 5d: resolve the opted-in named profile's storageState FRESH per launch (start AND crash
   * recovery), so a crash never loses the login. undefined return ⇒ clean session (no profile /
   * profile_absent). Host-injected; never logged.
   */
  loadProfile?: () => Promise<StorageStateInput>;
}

export class SessionBrowser {
  readonly sessionId: string;
  private readonly launcher: SessionBrowserLauncher;
  private readonly maxRestarts: number;
  private readonly loadProfile?: () => Promise<StorageStateInput>;
  private launched: LaunchedSessionBrowser | null = null;
  private _currentUrl = '';
  private closed = false;
  private recovering = false;
  private restartCount = 0;
  private readonly recoveredHandlers: Array<() => void> = [];
  private readonly beforeReNavHandlers: Array<(cdp: SessionCdp) => Promise<void>> = [];
  private readonly failedHandlers: Array<() => void> = [];

  constructor(opts: SessionBrowserOptions) {
    this.sessionId = opts.sessionId;
    this.launcher = opts.launch ?? defaultSessionLauncher;
    this.maxRestarts = opts.maxRestarts ?? getConfig().studioBrowserCrashMaxRestarts;
    this.loadProfile = opts.loadProfile;
  }

  /** Register a callback fired after a successful crash recovery (the screencast bridge restarts here in 1b). */
  onRecovered(cb: () => void): void {
    this.recoveredHandlers.push(cb);
  }

  /**
   * Register an AWAITED callback fired after relaunch but BEFORE the recovery
   * re-navigation, on the FRESH cdp. The nav interceptor rebinds here so a redirect
   * hop during recovery is re-validated on the fresh CDP (Finding A); non-nav
   * rebinds (screencast/input) stay in onRecovered since they don't gate navigation.
   */
  onBeforeReNav(cb: (cdp: SessionCdp) => Promise<void>): void {
    this.beforeReNavHandlers.push(cb);
  }

  /** Register a callback fired when recovery is abandoned after maxRestarts (the session is then terminal). */
  onFailed(cb: () => void): void {
    this.failedHandlers.push(cb);
  }

  get page(): SessionPage {
    if (!this.launched) throw new Error('session_browser_not_started');
    return this.launched.page;
  }

  get cdp(): SessionCdp {
    if (!this.launched) throw new Error('session_browser_not_started');
    return this.launched.cdp;
  }

  /**
   * Slice 5d — HOST-ONLY read-back of the live context's storageState, for 5e capture-after-login.
   * NEVER agent-reachable (no MCP tool returns it) and NEVER logged — it carries the session cookies.
   */
  async storageState(): Promise<StorageStateOut> {
    if (!this.launched) throw new Error('session_browser_not_started');
    return this.launched.context.storageState();
  }

  get currentUrl(): string {
    return this._currentUrl;
  }

  get running(): boolean {
    return this.launched !== null && !this.closed;
  }

  /** Launch the dedicated browser/context/page/CDP. Idempotent — a second call is a no-op. */
  async start(): Promise<void> {
    if (this.launched || this.closed) return;
    const cfg = getConfig();
    // Slice 5d: resolve the opted-in profile fresh (undefined ⇒ clean). Loaded into the context here.
    const storageState = await this.loadProfile?.();
    this.launched = await this.launcher({
      headless: cfg.studioBrowserHeadless,
      viewport: { width: cfg.studioScreencastMaxWidth, height: cfg.studioScreencastMaxHeight },
      ...(storageState !== undefined ? { storageState } : {}),
    });
    this.registerCrashHandlers();
    log.info('studio session browser started', { sessionId: this.sessionId, headless: cfg.studioBrowserHeadless });
  }

  /** Navigate the session page and record the destination as `currentUrl` (used by crash recovery). */
  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load', timeout: getConfig().playwrightNavTimeoutMs });
    this._currentUrl = url;
  }

  /** Tear down page → context → browser exactly once; idempotent and tolerant of already-closed handles. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const l = this.launched;
    this.launched = null;
    if (!l) return;
    await l.page.close().catch(() => {});
    await l.context.close().catch(() => {});
    await l.browser.close().catch(() => {});
    log.info('studio session browser closed', { sessionId: this.sessionId });
  }

  private registerCrashHandlers(): void {
    if (!this.launched) return;
    // The handlers never reject (handleCrash catches internally), so an async
    // listener is safe on Playwright's `(page) => void` / `() => void` signatures.
    this.launched.browser.on('disconnected', () => this.handleCrash('browser_disconnected'));
    this.launched.page.on('crash', () => this.handleCrash('page_crash'));
  }

  /**
   * A live browser/page died. Relaunch + re-navigate the last URL + restart the
   * screencast (via onRecovered) rather than hang — bounded by maxRestarts so a
   * crash-looping session goes terminal instead of relaunching forever. Ignored
   * during an intentional close (the close path also fires `disconnected`).
   */
  private async handleCrash(reason: string): Promise<void> {
    if (this.closed || this.recovering) return;
    this.recovering = true;
    try {
      if (this.restartCount >= this.maxRestarts) {
        this.fail(reason);
        return;
      }
      this.restartCount++;
      log.warn('studio session browser crashed; recovering', {
        sessionId: this.sessionId,
        reason,
        attempt: this.restartCount,
        maxRestarts: this.maxRestarts,
      });
      const cfg = getConfig();
      this.launched = null; // old handles are dead
      // Slice 5d: re-load the opted-in profile on the relaunch too — a crash must NOT lose the login.
      // Resolved fresh (so a 5e re-persist mid-session is picked up); undefined ⇒ clean.
      const storageState = await this.loadProfile?.();
      this.launched = await this.launcher({
        headless: cfg.studioBrowserHeadless,
        viewport: { width: cfg.studioScreencastMaxWidth, height: cfg.studioScreencastMaxHeight },
        ...(storageState !== undefined ? { storageState } : {}),
      });
      this.registerCrashHandlers();
      // Pre-nav hooks fire on the FRESH cdp BEFORE the recovery re-navigation, so a
      // guard that re-validates redirect hops (the nav interceptor) is live before
      // the goto — otherwise a recovery hop is unguarded on the agent path (Finding A).
      // Awaited: a fire-and-forget rebind could race the goto and re-open the gap.
      // REQUIRED, not best-effort: if a pre-nav guard cannot arm, fail the recovery
      // CLOSED (rethrow → the catch below calls fail()) rather than proceed into an
      // unguarded re-navigation. (onRecovered hooks, by contrast, are post-nav and
      // best-effort.)
      for (const cb of this.beforeReNavHandlers) {
        try {
          await cb(this.launched.cdp);
        } catch (err) {
          log.error('beforeReNav hook failed — failing recovery closed', { sessionId: this.sessionId, error: String(err) });
          throw err;
        }
      }
      if (this._currentUrl) {
        await this.launched.page
          .goto(this._currentUrl, { waitUntil: 'load', timeout: cfg.playwrightNavTimeoutMs })
          .catch((err) => log.warn('re-navigation after recovery failed', { sessionId: this.sessionId, error: String(err) }));
      }
      for (const cb of this.recoveredHandlers) cb();
      log.info('studio session browser recovered', { sessionId: this.sessionId, attempt: this.restartCount });
    } catch (err) {
      log.error('studio session browser recovery failed', { sessionId: this.sessionId, error: String(err) });
      this.fail(reason);
    } finally {
      this.recovering = false;
    }
  }

  private fail(reason: string): void {
    this.closed = true;
    this.launched = null;
    log.error('studio session browser gave up after crashes', {
      sessionId: this.sessionId,
      reason,
      restarts: this.restartCount,
    });
    for (const cb of this.failedHandlers) cb();
  }
}

/**
 * #318 — the session's bounded console collector: the "what did the browser engine say" half of pin 8's
 * post-actions (`ActPostActionDeps.consoleSince`).
 *
 * WHY THE `Log` DOMAIN AND NOT `Runtime` (decision, DECISIONS-AUTO.md 2026-09-02):
 * `Runtime.enable` is the dominant automation tell, and three separate fetch-side modules pin
 * "the connect + eval sequence issues ZERO `Runtime.enable`" as an invariant. A studio session is
 * attended and already enables `DOM`/`Overlay`, so it is arguably exempt — but "arguably exempt" is
 * how an invariant erodes. The `Log` domain carries what the summary actually counts (uncaught
 * exceptions, network failures, CSP/deprecation violations — the `errors`/`warnings` an agent needs
 * after a click) WITHOUT the tell, so we take it and pay the known price: page-authored
 * `console.log(...)` calls are NOT collected. That is the whole cost, stated rather than discovered.
 *
 * THE BUFFER IS BOUNDED AND DRAIN-ON-READ. A page can log without limit, so the ring keeps at most
 * `max` lines and each line at most `maxLineChars`; when it overflows, the OLDEST lines are dropped
 * (the most recent state of a spamming page is the useful half). `drain()` empties it, so one act
 * reports its own window instead of the session's whole history.
 *
 * The text is PAGE-AUTHORED and stays raw here — neutralization, truncation-to-sample and the
 * credential-context exclusion all live in `act.ts`'s summarizer, which is the one place that
 * decision is made. This class only collects.
 */
export const CONSOLE_BUFFER_MAX_LINES = 200;
export const CONSOLE_BUFFER_MAX_LINE_CHARS = 2000;

/** Structurally the `ConsoleMessage` pin 8's summarizer consumes; re-declared so this module imports no act types. */
export interface CollectedConsoleLine {
  level: 'error' | 'warning' | 'info' | 'log' | 'debug';
  text: string;
}

/** CDP `Log.LogEntry.level` → the summary's level vocabulary. `verbose` is the engine's word for debug. */
function toConsoleLevel(level: unknown): CollectedConsoleLine['level'] {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}

export class SessionConsoleBuffer {
  private lines: CollectedConsoleLine[] = [];
  private readonly max: number;
  private readonly maxLineChars: number;
  private readonly onEntry: (payload: never) => void;
  private bound: SessionCdp | null = null;

  constructor(opts: { max?: number; maxLineChars?: number } = {}) {
    this.max = opts.max ?? CONSOLE_BUFFER_MAX_LINES;
    this.maxLineChars = opts.maxLineChars ?? CONSOLE_BUFFER_MAX_LINE_CHARS;
    // One stable listener identity, so `off` on the dead cdp actually detaches.
    this.onEntry = ((payload: { entry?: { level?: unknown; text?: unknown } }) => {
      const entry = payload?.entry;
      if (!entry || typeof entry.text !== 'string') return;
      this.push({ level: toConsoleLevel(entry.level), text: entry.text.slice(0, this.maxLineChars) });
    }) as (payload: never) => void;
  }

  private push(line: CollectedConsoleLine): void {
    this.lines.push(line);
    // Drop from the FRONT so the bound holds no matter how long the session runs.
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  /**
   * Subscribe to the live session and re-subscribe after a crash recovery. Best-effort by
   * construction: `Log.enable` failing must never take a session down — a session with no console
   * collection is a working session, and the summary then honestly reports zero lines.
   *
   * The rebind rides `onRecovered` (post-nav, best-effort) and NOT `onBeforeReNav`, whose hooks fail
   * recovery CLOSED — a console collector is not worth a terminated session. The cost is that lines
   * emitted during the recovery re-navigation itself are not collected.
   */
  attach(browser: SessionBrowser): void {
    this.bind(browser);
    browser.onRecovered(() => this.bind(browser));
  }

  private bind(browser: SessionBrowser): void {
    let cdp: SessionCdp;
    try {
      cdp = browser.cdp;
    } catch {
      return; // not started / mid-recovery — the next bind gets the live handle
    }
    if (this.bound === cdp) return;
    if (this.bound) {
      try {
        this.bound.off('Log.entryAdded', this.onEntry);
      } catch {
        /* the old cdp is dead; detaching from it is a formality */
      }
    }
    this.bound = cdp;
    cdp.on('Log.entryAdded', this.onEntry);
    void Promise.resolve(cdp.send('Log.enable')).catch((err) =>
      log.warn('console collection unavailable for this session', {
        sessionId: browser.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /** Hand out everything collected since the last drain and empty the buffer. */
  drain(): readonly CollectedConsoleLine[] {
    const out = this.lines;
    this.lines = [];
    return out;
  }
}
