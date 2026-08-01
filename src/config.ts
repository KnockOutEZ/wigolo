import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseBrowserTypes } from './fetch/browser-types.js';
import type { BrowserType } from './types.js';
import {
  readPersistedConfig,
  resetPersistedConfig,
  defaultConfigPath,
  readCredentialFromKeychain,
} from './persisted-config.js';
import {
  credentialKeychainUser,
  recomposeWithUserinfo,
  splitUserinfo,
} from './fetch/proxy-credentials.js';

export interface Config {
  searxngUrl: string | null;
  searxngMode: 'native' | 'docker';
  searxngPort: number;
  fetchTimeoutMs: number;
  fetchMaxRetries: number;
  maxRedirects: number;
  fetchAllowPrivate: boolean;
  playwrightLoadTimeoutMs: number;
  playwrightNavTimeoutMs: number;
  /** Upper bound on the browser tier's challenge-completion poll. A detected
   * challenge is polled (not settled once) until the real page renders or a
   * `cf_clearance` cookie appears; a challenge that clears within this window
   * proceeds normally, otherwise it fast-fails. The effective deadline is the
   * min() of this and the caller's remaining fetch budget. */
  challengeCompletionTimeoutMs: number;
  searxngQueryTimeoutMs: number;
  searchFetchTimeoutMs: number;
  searchFetchTimeoutBalancedMs: number;
  searchFetchTimeoutDeepMs: number;
  searchStageBudgetBalancedMs: number;
  searchStageBudgetDeepMs: number;
  searchTotalTimeoutMs: number;
  /** Total per-URL fetch budget pool (ms) shared across a NARROW candidate set
   * during search enrichment. When set, each URL's per-URL budget is scaled up
   * proportionally to `1/candidateCount` (fewer candidates → more time each),
   * always clamped to the stage budget. `0`/undefined preserves the legacy
   * small per-URL budget regardless of candidate count. */
  searchNarrowSetBudgetMs: number;
  /** Max candidate count for which a domain-narrowed (`include_domains`) search
   * forces the browser-render path during enrichment. JS-heavy documentation
   * SPAs hand back an empty shell over the HTTP tier; rendering recovers real
   * content. Bounded to a FEW URLs so latency/cost stays controlled — broad
   * (non-domain-narrowed, many-URL) searches never escalate. `0` disables the
   * escalation entirely. */
  searchNarrowRenderMaxCandidates: number;
  /** Pre-launch the browser engine before search enrichment so the first
   * hydration fetch doesn't pay the browser cold-start inline. Latency-only —
   * no change to results. Defaults on; set false to disable. */
  searchPrewarmBrowser: boolean;
  /** Hold mojeek out of the primary search dispatch wave (probe-only). mojeek
   * reputation-blocks (403) most callers, contributing 0 results while burning
   * retry latency and tripping its breaker — a per-call tax that cascades the
   * pool toward bing-only under burst. Probe-only keeps it available to the
   * degraded-recovery wave (when the pool collapses and needs every signal)
   * without paying its cost on the happy path. Defaults on; set false
   * (WIGOLO_MOJEEK_PROBE_ONLY=false) to restore it to the primary wave. */
  searchMojeekProbeOnly: boolean;
  validateTimeoutMs: number;
  maxBrowsers: number;
  browserIdleTimeoutMs: number;
  browserFallbackThreshold: number;
  authStatePath: string | null;
  chromeProfilePath: string | null;
  cdpUrl: string | null;
  dataDir: string;
  cacheTtlSearch: number;
  cacheTtlContent: number;
  fastStaleMaxHours: number;
  fastTimeoutMs: number;
  crawlConcurrency: number;
  crawlDelayMs: number;
  crawlPrivateConcurrency: number;
  crawlPrivateDelayMs: number;
  /** Randomized jitter fraction applied to each crawl inter-request wait (0..1). Breaks the fixed-metronome bot signal. */
  crawlJitterPct: number;
  /** Multiplier applied to a domain's crawl wait on each 403/429 (adaptive back-off). */
  crawlCooldownFactor: number;
  /**
   * Ceiling for the adaptive per-domain crawl cooldown wait, in ms. Default
   * 30s: the cooldown only compounds while a domain keeps returning 403/429, and
   * a ceiling long enough to be genuinely polite is also long enough to be
   * indistinguishable from a hung crawl. Raise it deliberately for a domain
   * worth waiting on.
   */
  crawlCooldownMaxMs: number;
  useProxy: boolean;
  proxyUrl: string | null;
  /**
   * When a managed bot-protection challenge blocks the browser tier WHILE a
   * proxy is in use, attempt ONE additional direct (no-proxy) browser fetch
   * before returning blocked_by_challenge. A datacenter proxy converts many
   * managed-challenge passes into blocks, whereas direct residential-grade
   * egress often clears — and wigolo cannot know the proxy's ASN type.
   *
   * Default FALSE. Routing around an operator's configured proxy is a consent
   * decision, not an optimization: someone who set a proxy did so for privacy,
   * egress control, or policy reasons, and a silent direct retry leaks their
   * real IP to the origin. Opt in with WIGOLO_PROXY_BYPASS_ON_CHALLENGE=true.
   * No-op when no proxy is configured (no double-fetch either way).
   */
  proxyBypassOnChallenge: boolean;
  /** Opt-in challenge-solver service URL (Tier-B escape hatch). Off unless set. */
  solverUrl: string | null;
  /** Opt-in hosted reader-service URL (Tier-B escape hatch). Off unless set. */
  hostedReaderUrl: string | null;
  userAgent: string | null;
  validateLinks: boolean;
  respectRobotsTxt: boolean;
  braveApiKey: string | null;
  /** GitHub API personal access token. When set, the github-code adapter
   * passes it as a Bearer token so search calls run authenticated. Lifts
   * the 10 req/min unauthed cap to 30 req/min, eliminates the most common
   * 401 path for org-private result hydration, and is the env var named
   * in engine_warnings hints. Optional — the adapter still runs unauthed. */
  githubToken: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';
  reranker: 'onnx' | 'none' | 'custom';
  rerankerModel: string;
  rerankerMaxLength: number;
  rerankerReadyTimeoutMs: number;
  rerankerRequestTimeoutMs: number;
  rerankerIdleTimeoutMs: number;
  relevanceThreshold: number;
  findSimilarColdStartThreshold: number;
  bootstrapMaxAttempts: number;
  bootstrapBackoffSeconds: number[];
  healthProbeIntervalMs: number;
  daemonPort: number;
  daemonHost: string;
  pluginsDir: string;
  browserTypes: BrowserType[];
  shellHistoryPath: string;
  multiQueryConcurrency: number;
  multiQueryMax: number;
  embeddingModel: string;
  embeddingIdleTimeoutMs: number;
  embeddingMaxTextLength: number;
  /**
   * Search backend selector. Resolves `WIGOLO_SEARCH` env > persisted
   * `searchBackend` in config.json > built-in default (null = 'core').
   * `null` means "unset"; the search-provider factory treats it as 'core'.
   */
  searchBackend: string | null;
  llmProvider: string | null;
  /**
   * Base URL for a custom OpenAI-compatible LLM backend. Only consulted when
   * `llmProvider` is the `ollama` alias; overrides the default
   * http://localhost:11434. `null` means "use the default local Ollama base".
   */
  llmBaseUrl: string | null;
  llmCacheTtlDays: number;
  llmMaxCallsPerRequest: number;
  /**
   * Opt-in auto-detect ladder for a local language model server. Resolves
   * `WIGOLO_LOCAL_LLM` env > persisted `localLlm` > default:
   *   - 'off'  : disabled (DEFAULT) — behavior is unchanged from before this
   *              knob existed; no probe is ever made.
   *   - 'auto' : probe the default local endpoint and use it when reachable.
   *   - an http(s):// URL : probe that explicit endpoint instead of the default.
   * Any other value normalizes to 'off' (fail-safe). Consumed by
   * `resolveLocalModelTier()`; never mutates the keyless / cloud LLM path.
   */
  localLlm: 'off' | 'auto' | string;
  /**
   * Preferred model name for the local-LLM tier. `null` lets the tier
   * auto-pick an installed model. Resolves `WIGOLO_LOCAL_LLM_MODEL` env >
   * persisted `localLlmModel` > null.
   */
  localLlmModel: string | null;
  /**
   * TLS-impersonation HTTP tier mode:
   *   - 'off'  : tier disabled, current pipeline unchanged (DEFAULT)
   *   - 'auto' : only invoked on anti-bot signal (403/429/503 or challenge body)
   *   - 'on'   : tried first for cold domains, then HTTP, then Playwright
   */
  tlsTier: 'off' | 'auto' | 'on';
  /**
   * Anti-bot fingerprint hardening / challenge-handling mode for the browser
   * tier:
   *   - 'off'  : never harden — the browser tier always uses the pooled default
   *              fingerprint.
   *   - 'auto' : harden ONLY when a browser fetch is an anti-bot / challenge
   *              escalation (DEFAULT). A plain SPA-shell render or an explicit
   *              browser request (render_js:'always' / auth / actions) is
   *              unaffected.
   *   - 'on'   : harden every browser fetch.
   * Any other value normalizes to 'auto' (the safe default).
   */
  stealth: 'off' | 'auto' | 'on';
  /**
   * Which browser build the DEDICATED stealth path launches:
   *   - 'chromium' : always use the bundled browser engine, never probe for an
   *                  installed one (DEFAULT).
   *   - 'auto'     : prefer an authentic installed browser (real TLS + version),
   *                  falling back to the bundled engine when none is installed.
   *   - 'chrome'   : force the authentic installed browser; still falls back to
   *                  bundled if the launch fails.
   * Any other value normalizes to 'chromium'. Applies to the stealth path only —
   * the pooled fast path is unaffected.
   *
   * Defaults to the BUNDLED engine so every install renders through the same
   * pinned browser. Launching whatever build happens to be on the host makes
   * behaviour vary per machine for no measured anti-bot gain — the levers that
   * actually decide a bot-wall outcome measured as classifier + IP, not browser
   * identity. Opt in with WIGOLO_BROWSER_CHANNEL=auto.
   */
  browserChannel: 'auto' | 'chrome' | 'chromium';
  /**
   * When true, the DEDICATED stealth path launches with a visible-window
   * (headful) browser for the strongest fingerprint. Default false: the stealth
   * path uses the browser engine's windowless headless mode (headful-grade
   * fingerprint, no visible window) so a background server never pops a window.
   * Enable only on a machine with a display (or CI with a virtual display).
   * Applies to the stealth path only.
   */
  browserHeadful: boolean;
  /**
   * Force the WINDOWLESS path on the raw-CDP rung even when a display exists.
   *
   * That rung prefers a real headful browser (minimized) because headless is
   * itself an automation tell; on a desktop that still starts a browser process
   * owning a real — if never visible — window. Setting this launches headless
   * instead and presents a coherent headless identity (user agent + client hints
   * + device pixel ratio matching the SAME binary running headful), so no window
   * is ever created. Off by default: headful remains the stronger posture, and
   * this trades a little of that for a guarantee of no window.
   */
  browserWindowless: boolean;
  /**
   * Driver selection for the DEDICATED browser-tier stealth launch:
   *   - 'playwright' : always use the standard browser driver; never load the
   *                    hardened driver even when installed (DEFAULT).
   *   - 'auto'       : use the driver-hardened stealth launcher (patches the
   *                    CDP `Runtime.enable`-class automation leak at the driver
   *                    level) WHEN its optional package + browser are present;
   *                    otherwise fall back to the standard browser driver.
   *   - 'patchright' : same as 'auto'.
   * Only affects the dedicated stealth launch. The pooled fast path and the
   * firefox/webkit engines are unaffected (the hardened driver is Chromium-only).
   * Any other value normalizes to 'playwright'.
   *
   * Defaults to the STANDARD driver. The hardened driver resolves a browser
   * revision it neither installs nor owns, and the launch path has no fallback:
   * once the hardened launcher is selected, every launch attempt goes through it
   * (a failed `channel:'chrome'` probe still retries on the SAME launcher), so a
   * driver that imports but cannot launch hard-fails the fetch rather than
   * degrading. Nothing asserts that its expected browser revision stays aligned
   * with the standard driver's. Opt in with WIGOLO_STEALTH_DRIVER=auto.
   */
  stealthDriver: 'auto' | 'patchright' | 'playwright';
  /**
   * Opt-in HUMAN-LIKE INTERACTION layer on the browser tier. 2026 anti-bot
   * walls (Cloudflare, DataDome) score SESSION BEHAVIOR — mouse movement,
   * scroll, timing — not just fingerprint/TLS. When engaged, a bounded,
   * dependency-free behavioral pass (curved mouse traversal + small randomized
   * scroll + randomized delays, hard time-capped) runs on the browser tier
   * AFTER navigation settles and BEFORE content extraction.
   *   - 'off'  : never engage; browser fetches pay zero behavioral cost
   *              (DEFAULT).
   *   - 'auto' : engage ONLY on the anti-bot / stealth escalation path — a
   *              benign, non-escalated browser fetch does NOT pay the cost.
   *   - 'on'   : engage on every browser fetch.
   * Any other value normalizes to 'off' (the safe default).
   *
   * Defaults OFF. The pass is reactive (escalation path only), so it never
   * slows a successful fetch — but it does add ~1.2s to one that ends up
   * blocked anyway, and behavioural interaction did not measure as a lever that
   * changes a bot-wall outcome (passive render sufficed). Opt in with
   * WIGOLO_HUMANIZE=auto.
   */
  humanize: 'off' | 'auto' | 'on';
  /**
   * "Hardcore" umbrella preset. When `'on'`, a pure resolver flips the anti-bot
   * / solve knobs to their most aggressive settings (stealth on, chrome channel,
   * headful, patchright driver, humanize on, cdpDirect auto, autoPass/aiSolve/
   * humanSolve on, raised challenge timeout) — UNLESS an individual knob was
   * explicitly provided (env or persisted). Precedence: explicit knob > hardcore
   * preset > default. `'off'` (default) leaves every knob at its own default.
   * Any other value normalizes to `'off'`. WIGOLO_HARDCORE.
   */
  hardcore: 'off' | 'on';
  /**
   * Automated interactive-challenge pass (trusted-input gesture on a checkbox /
   * Turnstile widget). 'off' (DEFAULT) | 'auto' (engage on the escalation path)
   * | 'on'. Any other value normalizes to 'off'. WIGOLO_AUTO_PASS.
   *
   * Defaults OFF. The rung only runs on a fetch that already hit a challenge, so
   * it never slows a successful one, but it adds ~3s to a fetch that ends up
   * blocked anyway and has no measured win. Opt in with WIGOLO_AUTO_PASS=auto.
   */
  autoPass: 'off' | 'auto' | 'on';
  /**
   * Raw control-plane fetch rung (Layer-B, P0-gated). 'off' (DEFAULT) | 'auto'
   * (engage on escalation when a real installed browser is present) | 'on'. Any
   * other value normalizes to 'off'. WIGOLO_CDP_DIRECT.
   */
  cdpDirect: 'off' | 'auto' | 'on';
  /**
   * In-band vision solve for visible-image challenges. Off by default (pointing
   * a model at a security-control captcha may breach a provider AUP; opt-in +
   * labeled). 'off' (DEFAULT) | 'auto' | 'on'. Any other value normalizes to
   * 'off'. WIGOLO_AI_SOLVE.
   */
  aiSolve: 'off' | 'auto' | 'on';
  /** Bounded vision-solve attempts (each = one vision call). Clamped to >= 1.
   * Default 2. WIGOLO_AI_SOLVE_MAX_ATTEMPTS. */
  aiSolveMaxAttempts: number;
  /**
   * Human-solve last rung. Engages ONLY with consent + a visible surface; a hard
   * no-op on headless/hosted. 'off' (DEFAULT) | 'auto' | 'on'. Any other value
   * normalizes to 'off'. WIGOLO_HUMAN_SOLVE.
   */
  humanSolve: 'off' | 'auto' | 'on';
  /** Poll budget (ms) for the human-solve rung. Default 120000.
   * WIGOLO_HUMAN_SOLVE_MS. */
  humanSolveTimeoutMs: number;
  /** Explicit consent gate for the human-solve rung. Default false.
   * WIGOLO_HUMAN_SOLVE_CONSENT. */
  humanSolveConsent: boolean;
  /**
   * Opt-in hosted-CDP (Bright-Data-style) websocket endpoint. When set, an
   * escape rung connects over this CDP endpoint (built-in IP + solver +
   * fingerprint server-side) instead of launching locally. Credential-gated,
   * keychain-backed (denylisted so it never persists cleartext). `null` (default)
   * leaves the rung off. WIGOLO_SCRAPING_BROWSER_WSS.
   */
  scrapingBrowserWss: string | null;
  /**
   * Opt-in Reddit OAuth app client id (non-secret). Paired with
   * `redditClientSecret`, enables the credential-gated Reddit OAuth-API fetch
   * path: when both are present AND a fetch targets a Reddit URL, the router
   * fetches via the official API instead of hitting the IP-reputation block.
   * `null` (default) leaves the path off — Reddit fetches go through the normal
   * ladder (which honestly hits the block). WIGOLO_REDDIT_CLIENT_ID.
   */
  redditClientId: string | null;
  /**
   * Opt-in Reddit OAuth app client SECRET. Keychain-backed: added to
   * SETTINGS_SECRETS_DENYLIST so it is never persisted to config.json in
   * cleartext; the config resolve path recomposes it from the OS keychain (or
   * reads it from WIGOLO_REDDIT_CLIENT_SECRET). `null` when unset.
   */
  redditClientSecret: string | null;
  /**
   * User-agent Reddit requires on both the token and data requests. Non-secret.
   * Defaults to a generic capability-clean UA. WIGOLO_REDDIT_USER_AGENT.
   */
  redditUserAgent: string;
  /** Browser fingerprint profile passed to the TLS-impersonation backend. */
  tlsBrowser: string;
  /** Successes required before a domain is auto-promoted to TLS-first routing. */
  tlsSuccessThreshold: number;
  /**
   * Extra domains (beyond the built-in anti-bot allowlist) that should try the
   * TLS-impersonation tier FIRST during a content fetch — even when `tlsTier`
   * is 'off'. Curated for known anti-bot, connection-timeout-prone content
   * domains (e.g. stackoverflow.com) whose plain-HTTP fetch times out before
   * returning a response, so the signal-based escalation never fires.
   */
  tlsDomains: string[];
}

/**
 * Env-var helpers.  Each helper follows the precedence rule:
 *   explicit env var > persisted config.json value > built-in default.
 *
 * `settings` is the `settings` map from the persisted config for this process
 * invocation. Passing it explicitly keeps the helpers pure and testable.
 */

function envStr(
  key: string,
  fallback: string | null,
  settings: Record<string, unknown>,
  settingsKey?: string,
): string | null {
  const envVal = process.env[key];
  if (envVal !== undefined) return envVal;
  const sk = settingsKey ?? key;
  const persisted = settings[sk];
  if (typeof persisted === 'string') return persisted;
  return fallback;
}

function envInt(
  key: string,
  fallback: number,
  settings: Record<string, unknown>,
  settingsKey?: string,
): number {
  const envVal = process.env[key];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    return isNaN(parsed) ? fallback : parsed;
  }
  const sk = settingsKey ?? key;
  const persisted = settings[sk];
  if (typeof persisted === 'number' && !isNaN(persisted)) return persisted;
  return fallback;
}

function envFloat(
  key: string,
  fallback: number,
  settings: Record<string, unknown>,
  settingsKey?: string,
): number {
  const envVal = process.env[key];
  if (envVal !== undefined) {
    const parsed = parseFloat(envVal);
    return isNaN(parsed) ? fallback : parsed;
  }
  const sk = settingsKey ?? key;
  const persisted = settings[sk];
  if (typeof persisted === 'number' && !isNaN(persisted)) return persisted;
  return fallback;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// The cooldown factor multiplies the per-domain wait on an anti-bot block. A
// factor <= 1 would leave pace unchanged (=1) or, if the decay ever divides by
// it, degenerate. Floor it at 1 so a misconfigured value never disables the
// adaptive cooldown.
function atLeast1(n: number): number {
  return n >= 1 ? n : 1;
}

function envIntArray(
  key: string,
  fallback: number[],
  settings: Record<string, unknown>,
  settingsKey?: string,
): number[] {
  const envVal = process.env[key];
  if (envVal !== undefined) {
    const parts = envVal.split(',').map(s => parseInt(s.trim(), 10));
    if (parts.some(n => isNaN(n))) return fallback;
    return parts;
  }
  const sk = settingsKey ?? key;
  const persisted = settings[sk];
  if (Array.isArray(persisted) && persisted.every(n => typeof n === 'number' && !isNaN(n))) {
    return persisted as number[];
  }
  return fallback;
}

function envBool(
  key: string,
  fallback: boolean,
  settings: Record<string, unknown>,
  settingsKey?: string,
): boolean {
  const envVal = process.env[key];
  if (envVal !== undefined) return envVal.toLowerCase() !== 'false' && envVal !== '0';
  const sk = settingsKey ?? key;
  const persisted = settings[sk];
  if (typeof persisted === 'boolean') return persisted;
  return fallback;
}

/**
 * True when a knob was EXPLICITLY provided — an env var is present OR the
 * persisted `settings` map carries its key. Used by the hardcore preset to
 * honour the precedence rule (explicit knob > hardcore preset > default): a
 * preset value is only applied to knobs the operator did not set themselves.
 */
function isExplicit(envKey: string, settingsKey: string, settings: Record<string, unknown>): boolean {
  return process.env[envKey] !== undefined || settings[settingsKey] !== undefined;
}

/**
 * The knobs the hardcore preset flips, each with the env + persisted key that
 * marks it "explicitly set". Kept as data so `applyHardcorePreset` stays a pure,
 * exhaustively-tested transform. NOT included: `proxyBypassOnChallenge` — its
 * default is already `true`, so a preset entry would be a no-op the resolver
 * test would falsely assert (spec §3.7 / review A4).
 */
interface HardcoreKnob {
  envKey: string;
  settingsKey: string;
  apply: (cfg: Config) => void;
}

const HARDCORE_KNOBS: HardcoreKnob[] = [
  { envKey: 'WIGOLO_STEALTH', settingsKey: 'stealth', apply: (c) => { c.stealth = 'on'; } },
  { envKey: 'WIGOLO_BROWSER_CHANNEL', settingsKey: 'browserChannel', apply: (c) => { c.browserChannel = 'chrome'; } },
  { envKey: 'WIGOLO_BROWSER_HEADFUL', settingsKey: 'browserHeadful', apply: (c) => { c.browserHeadful = true; } },
  { envKey: 'WIGOLO_STEALTH_DRIVER', settingsKey: 'stealthDriver', apply: (c) => { c.stealthDriver = 'patchright'; } },
  { envKey: 'WIGOLO_HUMANIZE', settingsKey: 'humanize', apply: (c) => { c.humanize = 'on'; } },
  { envKey: 'WIGOLO_CDP_DIRECT', settingsKey: 'cdpDirect', apply: (c) => { c.cdpDirect = 'auto'; } },
  { envKey: 'WIGOLO_AUTO_PASS', settingsKey: 'autoPass', apply: (c) => { c.autoPass = 'on'; } },
  { envKey: 'WIGOLO_AI_SOLVE', settingsKey: 'aiSolve', apply: (c) => { c.aiSolve = 'on'; } },
  { envKey: 'WIGOLO_HUMAN_SOLVE', settingsKey: 'humanSolve', apply: (c) => { c.humanSolve = 'on'; } },
];

/** Minimum challenge-completion budget the hardcore preset guarantees (ms). */
export const HARDCORE_CHALLENGE_COMPLETION_MIN_MS = 30000;

/**
 * Apply the hardcore preset in place. When `cfg.hardcore === 'on'`, flip each
 * preset knob to its aggressive value UNLESS the operator explicitly set that
 * knob (env or persisted). Also raise the challenge-completion budget to at
 * least the hardcore floor without ever lowering a caller-supplied larger value.
 *
 * Pure w.r.t. the passed `settings` snapshot + current `process.env`; a no-op
 * when hardcore is off. Exported for direct unit testing.
 */
export function applyHardcorePreset(cfg: Config, settings: Record<string, unknown>): void {
  if (cfg.hardcore !== 'on') return;
  for (const knob of HARDCORE_KNOBS) {
    if (!isExplicit(knob.envKey, knob.settingsKey, settings)) knob.apply(cfg);
  }
  // Raise the challenge-completion budget to the hardcore floor, but never lower
  // an explicit/default value the caller already set higher.
  cfg.challengeCompletionTimeoutMs = Math.max(
    cfg.challengeCompletionTimeoutMs,
    HARDCORE_CHALLENGE_COMPLETION_MIN_MS,
  );
}

/**
 * Allowlist guard for `WIGOLO_TLS_BROWSER`. The TLS-impersonation backend
 * passes this string into a Rust napi binding; an unvalidated value can
 * crash the binding on unknown profiles. Accept only the documented browser
 * families (`chrome|firefox|safari|edge|opera`) followed by a numeric
 * version. On mismatch, log a warning to stderr and return the safe default.
 *
 * Exported for tests; the production call site lives in `getConfig()`.
 */
const TLS_BROWSER_PATTERN = /^(chrome|firefox|safari|edge|opera)_\d+$/;

export function validateTlsBrowser(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (TLS_BROWSER_PATTERN.test(raw)) return raw;
  // Use stderr directly: the logger module imports config, so taking a
  // logger here would create a cycle. A single warning at startup is
  // intentional.
  process.stderr.write(
    `[wigolo] WIGOLO_TLS_BROWSER=${JSON.stringify(raw)} is not in the allowlist ` +
      `(${TLS_BROWSER_PATTERN.source}); falling back to ${fallback}\n`,
  );
  return fallback;
}

/**
 * Resolve a proxy/solver/reader URL, re-composing a keychain-stored credential
 * onto a credential-free host URL. A value that already carries inline userinfo
 * (typically from an env var — trusted + ephemeral) is used verbatim; the
 * keychain is only consulted to complete a stripped, disk-persisted URL.
 */
function resolveCredentialUrl(raw: string | null, settingsKey: string): string | null {
  if (!raw) return raw;
  const { userinfo } = splitUserinfo(raw);
  if (userinfo !== null) return raw; // already has creds (env) — use as-is
  const stored = readCredentialFromKeychain(credentialKeychainUser(settingsKey));
  if (!stored) return raw;
  return recomposeWithUserinfo(raw, stored);
}

/**
 * Resolve a plain-string secret (no URL wrapper): env var > OS keychain entry
 * stored under `credentialKeychainUser(settingsKey)`. The value is NEVER read
 * from persisted config.json (the denylist strips it on the write path), so a
 * disk config never holds the cleartext secret. `null` when unset everywhere.
 */
function resolveKeychainSecret(envKey: string, settingsKey: string): string | null {
  const envVal = process.env[envKey];
  if (envVal !== undefined && envVal !== '') return envVal;
  return readCredentialFromKeychain(credentialKeychainUser(settingsKey));
}

/** Default user-agent for the opt-in Reddit OAuth-API path. Generic +
 * capability-clean; overridable via WIGOLO_REDDIT_USER_AGENT. */
export const DEFAULT_REDDIT_USER_AGENT = 'web:wigolo:v1.0 (web intelligence agent)';

/**
 * True when the opt-in Reddit OAuth-API path is fully configured: both the
 * client id and the (keychain-backed) client secret are present. When false the
 * router never routes to the API — Reddit fetches use the normal ladder.
 */
export function redditApiConfigured(cfg: Config = getConfig()): boolean {
  return !!cfg.redditClientId && !!cfg.redditClientSecret;
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  // Load persisted settings once. Precedence per field:
  //   explicit env var > config.json value > built-in default
  const { settings } = readPersistedConfig(defaultConfigPath());

  // Helpers below accept `settings` so each field independently checks
  // whether an env var is present before falling through to the persisted value.

  const cdpRaw = envStr('WIGOLO_CDP_URL', null, settings, 'cdpUrl');
  const dataDirRaw = envStr('WIGOLO_DATA_DIR', null, settings, 'dataDir');
  const dataDir = dataDirRaw ?? join(homedir(), '.wigolo');

  cachedConfig = {
    searxngUrl: envStr('SEARXNG_URL', null, settings, 'searxngUrl'),
    searxngMode: (envStr('SEARXNG_MODE', 'native', settings, 'searxngMode') as 'native' | 'docker'),
    searxngPort: envInt('SEARXNG_PORT', 8888, settings, 'searxngPort'),
    fetchTimeoutMs: envInt('FETCH_TIMEOUT_MS', 10000, settings, 'fetchTimeoutMs'),
    fetchMaxRetries: envInt('FETCH_MAX_RETRIES', 2, settings, 'fetchMaxRetries'),
    maxRedirects: envInt('MAX_REDIRECTS', 5, settings, 'maxRedirects'),
    fetchAllowPrivate: envBool('WIGOLO_FETCH_ALLOW_PRIVATE', false, settings, 'fetchAllowPrivate'),
    playwrightLoadTimeoutMs: envInt('PLAYWRIGHT_LOAD_TIMEOUT_MS', 15000, settings, 'playwrightLoadTimeoutMs'),
    playwrightNavTimeoutMs: envInt('PLAYWRIGHT_NAV_TIMEOUT_MS', 30000, settings, 'playwrightNavTimeoutMs'),
    challengeCompletionTimeoutMs: envInt('WIGOLO_CHALLENGE_COMPLETION_MS', 15000, settings, 'challengeCompletionTimeoutMs'),
    searxngQueryTimeoutMs: envInt('SEARXNG_QUERY_TIMEOUT_MS', 8000, settings, 'searxngQueryTimeoutMs'),
    searchFetchTimeoutMs: envInt('SEARCH_FETCH_TIMEOUT_MS', 15000, settings, 'searchFetchTimeoutMs'),
    searchFetchTimeoutBalancedMs: envInt('SEARCH_FETCH_TIMEOUT_BALANCED_MS', 3000, settings, 'searchFetchTimeoutBalancedMs'),
    searchFetchTimeoutDeepMs: envInt('SEARCH_FETCH_TIMEOUT_DEEP_MS', 8000, settings, 'searchFetchTimeoutDeepMs'),
    searchStageBudgetBalancedMs: envInt('SEARCH_STAGE_BUDGET_BALANCED_MS', 4000, settings, 'searchStageBudgetBalancedMs'),
    searchStageBudgetDeepMs: envInt('SEARCH_STAGE_BUDGET_DEEP_MS', 10000, settings, 'searchStageBudgetDeepMs'),
    searchTotalTimeoutMs: envInt('SEARCH_TOTAL_TIMEOUT_MS', 30000, settings, 'searchTotalTimeoutMs'),
    searchNarrowSetBudgetMs: envInt('SEARCH_NARROW_SET_BUDGET_MS', 8000, settings, 'searchNarrowSetBudgetMs'),
    searchNarrowRenderMaxCandidates: envInt('SEARCH_NARROW_RENDER_MAX_CANDIDATES', 3, settings, 'searchNarrowRenderMaxCandidates'),
    searchPrewarmBrowser: envBool('SEARCH_PREWARM_BROWSER', true, settings, 'searchPrewarmBrowser'),
    searchMojeekProbeOnly: envBool('WIGOLO_MOJEEK_PROBE_ONLY', true, settings, 'searchMojeekProbeOnly'),
    validateTimeoutMs: envInt('VALIDATE_TIMEOUT_MS', 5000, settings, 'validateTimeoutMs'),
    maxBrowsers: envInt('MAX_BROWSERS', 3, settings, 'maxBrowsers'),
    browserIdleTimeoutMs: envInt('BROWSER_IDLE_TIMEOUT', 60000, settings, 'browserIdleTimeoutMs'),
    browserFallbackThreshold: envInt('BROWSER_FALLBACK_THRESHOLD', 3, settings, 'browserFallbackThreshold'),
    authStatePath: envStr('WIGOLO_AUTH_STATE_PATH', null, settings, 'authStatePath'),
    chromeProfilePath: envStr('WIGOLO_CHROME_PROFILE_PATH', null, settings, 'chromeProfilePath'),
    cdpUrl: cdpRaw || null,
    dataDir,
    cacheTtlSearch: envInt('CACHE_TTL_SEARCH', 86400, settings, 'cacheTtlSearch'),
    cacheTtlContent: envInt('CACHE_TTL_CONTENT', 604800, settings, 'cacheTtlContent'),
    fastStaleMaxHours: envInt('WIGOLO_FAST_STALE_MAX_HOURS', 24, settings, 'fastStaleMaxHours'),
    fastTimeoutMs: envInt('WIGOLO_FAST_TIMEOUT_MS', 800, settings, 'fastTimeoutMs'),
    crawlConcurrency: envInt('CRAWL_CONCURRENCY', 2, settings, 'crawlConcurrency'),
    crawlDelayMs: envInt('CRAWL_DELAY_MS', 500, settings, 'crawlDelayMs'),
    crawlPrivateConcurrency: envInt('CRAWL_PRIVATE_CONCURRENCY', 10, settings, 'crawlPrivateConcurrency'),
    crawlPrivateDelayMs: envInt('CRAWL_PRIVATE_DELAY_MS', 0, settings, 'crawlPrivateDelayMs'),
    crawlJitterPct: clamp01(envFloat('WIGOLO_CRAWL_JITTER_PCT', 0.3, settings, 'crawlJitterPct')),
    crawlCooldownFactor: atLeast1(envFloat('WIGOLO_CRAWL_COOLDOWN_FACTOR', 2, settings, 'crawlCooldownFactor')),
    crawlCooldownMaxMs: envInt('WIGOLO_CRAWL_COOLDOWN_MAX_MS', 30000, settings, 'crawlCooldownMaxMs'),
    useProxy: envBool('USE_PROXY', false, settings, 'useProxy'),
    proxyUrl: resolveCredentialUrl(envStr('PROXY_URL', null, settings, 'proxyUrl'), 'proxyUrl'),
    proxyBypassOnChallenge: envBool('WIGOLO_PROXY_BYPASS_ON_CHALLENGE', false, settings, 'proxyBypassOnChallenge'),
    solverUrl: resolveCredentialUrl(
      envStr('WIGOLO_SOLVER_URL', null, settings, 'solverUrl'),
      'solverUrl',
    ),
    hostedReaderUrl: resolveCredentialUrl(
      envStr('WIGOLO_HOSTED_READER_URL', null, settings, 'hostedReaderUrl'),
      'hostedReaderUrl',
    ),
    userAgent: envStr('USER_AGENT', null, settings, 'userAgent'),
    validateLinks: envBool('VALIDATE_LINKS', true, settings, 'validateLinks'),
    respectRobotsTxt: envBool('RESPECT_ROBOTS_TXT', true, settings, 'respectRobotsTxt'),
    braveApiKey: envStr('BRAVE_API_KEY', null, settings, 'braveApiKey'),
    githubToken: envStr('WIGOLO_GITHUB_TOKEN', null, settings, 'githubToken'),
    logLevel: (envStr('LOG_LEVEL', 'info', settings, 'logLevel') as Config['logLevel']),
    logFormat: (envStr('LOG_FORMAT', 'json', settings, 'logFormat') as Config['logFormat']),
    reranker: (() => {
      const raw = envStr('WIGOLO_RERANKER', null, settings, 'reranker') ?? 'onnx';
      if (raw === 'flashrank') {
        process.stderr.write(
          '[wigolo] WIGOLO_RERANKER=flashrank is a legacy alias; treating as onnx. ' +
          'The reranker runs as a Python subprocess; install via "wigolo warmup --reranker".\n',
        );
        return 'onnx';
      }
      return raw as Config['reranker'];
    })(),
    rerankerModel: envStr('WIGOLO_RERANKER_MODEL', 'bge-reranker-v2-m3', settings, 'rerankerModel') ?? 'bge-reranker-v2-m3',
    rerankerMaxLength: envInt('WIGOLO_RERANKER_MAX_LENGTH', 512, settings, 'rerankerMaxLength'),
    rerankerReadyTimeoutMs: envInt('WIGOLO_RERANKER_READY_TIMEOUT_MS', 60_000, settings, 'rerankerReadyTimeoutMs'),
    rerankerRequestTimeoutMs: envInt('WIGOLO_RERANKER_REQUEST_TIMEOUT_MS', 30_000, settings, 'rerankerRequestTimeoutMs'),
    rerankerIdleTimeoutMs: envInt('WIGOLO_RERANKER_IDLE_TIMEOUT_MS', 300_000, settings, 'rerankerIdleTimeoutMs'),
    relevanceThreshold: (() => {
      const raw = envStr('WIGOLO_RELEVANCE_THRESHOLD', null, settings, 'relevanceThreshold');
      if (raw === null || raw === '') return 0;
      const n = parseFloat(raw);
      return isNaN(n) ? 0 : n;
    })(),
    findSimilarColdStartThreshold: (() => {
      const raw = envStr('WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD', null, settings, 'findSimilarColdStartThreshold');
      if (raw === null || raw === '') return 0.02;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 0.02;
    })(),
    bootstrapMaxAttempts: envInt('WIGOLO_BOOTSTRAP_MAX_ATTEMPTS', 3, settings, 'bootstrapMaxAttempts'),
    bootstrapBackoffSeconds: envIntArray('WIGOLO_BOOTSTRAP_BACKOFF_SECONDS', [30, 3600, 86400], settings, 'bootstrapBackoffSeconds'),
    healthProbeIntervalMs: envInt('WIGOLO_HEALTH_PROBE_INTERVAL_MS', 30000, settings, 'healthProbeIntervalMs'),
    daemonPort: envInt('WIGOLO_DAEMON_PORT', 3333, settings, 'daemonPort'),
    daemonHost: (() => {
      const raw = envStr('WIGOLO_DAEMON_HOST', '127.0.0.1', settings, 'daemonHost');
      return raw?.trim() || '127.0.0.1';
    })(),
    pluginsDir: (() => {
      const raw = envStr('WIGOLO_PLUGINS_DIR', null, settings, 'pluginsDir');
      if (raw) {
        if (raw.startsWith('~')) return join(homedir(), raw.slice(1));
        return raw;
      }
      return join(dataDir, 'plugins');
    })(),
    browserTypes: parseBrowserTypes(envStr('WIGOLO_BROWSER_TYPES', null, settings, 'browserTypes') as string | null),
    shellHistoryPath: envStr('WIGOLO_SHELL_HISTORY_PATH', null, settings, 'shellHistoryPath') ?? join(homedir(), '.wigolo', 'shell-history'),
    multiQueryConcurrency: envInt('WIGOLO_MULTI_QUERY_CONCURRENCY', 5, settings, 'multiQueryConcurrency'),
    multiQueryMax: envInt('WIGOLO_MULTI_QUERY_MAX', 10, settings, 'multiQueryMax'),
    embeddingModel: envStr('WIGOLO_EMBEDDING_MODEL', 'BAAI/bge-small-en-v1.5', settings, 'embeddingModel') ?? 'BAAI/bge-small-en-v1.5',
    embeddingIdleTimeoutMs: envInt('WIGOLO_EMBEDDING_IDLE_TIMEOUT', 1800000, settings, 'embeddingIdleTimeoutMs'),
    embeddingMaxTextLength: envInt('WIGOLO_EMBEDDING_MAX_TEXT_LENGTH', 8000, settings, 'embeddingMaxTextLength'),
    searchBackend: envStr('WIGOLO_SEARCH', null, settings, 'searchBackend'),
    llmProvider: envStr('WIGOLO_LLM_PROVIDER', null, settings, 'llmProvider'),
    llmBaseUrl: envStr('WIGOLO_LLM_BASE_URL', null, settings, 'llmBaseUrl'),
    llmCacheTtlDays: envInt('WIGOLO_LLM_CACHE_TTL_DAYS', 7, settings, 'llmCacheTtlDays'),
    llmMaxCallsPerRequest: envInt('WIGOLO_LLM_MAX_CALLS_PER_REQUEST', 1, settings, 'llmMaxCallsPerRequest'),
    localLlm: (() => {
      const raw = envStr('WIGOLO_LOCAL_LLM', null, settings, 'localLlm');
      if (!raw) return 'off';
      const lower = raw.toLowerCase();
      if (lower === 'auto' || lower === 'off') return lower;
      // An explicit OpenAI-compatible endpoint is a valid third value; keep it
      // verbatim so the resolver can probe it. Anything else is a typo → off.
      if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
      return 'off';
    })(),
    localLlmModel: envStr('WIGOLO_LOCAL_LLM_MODEL', null, settings, 'localLlmModel'),
    tlsTier: (() => {
      const raw = (envStr('WIGOLO_TLS_TIER', 'off', settings, 'tlsTier') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    stealth: (() => {
      const raw = (envStr('WIGOLO_STEALTH', 'auto', settings, 'stealth') ?? 'auto').toLowerCase();
      return raw === 'off' || raw === 'on' ? (raw as 'off' | 'on') : 'auto';
    })(),
    browserChannel: (() => {
      const raw = (envStr('WIGOLO_BROWSER_CHANNEL', 'chromium', settings, 'browserChannel') ?? 'chromium').toLowerCase();
      return raw === 'chrome' || raw === 'auto' ? (raw as 'chrome' | 'auto') : 'chromium';
    })(),
    browserHeadful: envBool('WIGOLO_BROWSER_HEADFUL', false, settings, 'browserHeadful'),
    browserWindowless: envBool('WIGOLO_BROWSER_WINDOWLESS', false, settings, 'browserWindowless'),
    stealthDriver: (() => {
      const raw = (envStr('WIGOLO_STEALTH_DRIVER', 'playwright', settings, 'stealthDriver') ?? 'playwright').toLowerCase();
      return raw === 'patchright' || raw === 'auto'
        ? (raw as 'patchright' | 'auto')
        : 'playwright';
    })(),
    humanize: (() => {
      const raw = (envStr('WIGOLO_HUMANIZE', 'off', settings, 'humanize') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    hardcore: (() => {
      const raw = (envStr('WIGOLO_HARDCORE', 'off', settings, 'hardcore') ?? 'off').toLowerCase();
      return raw === 'on' ? 'on' : 'off';
    })(),
    autoPass: (() => {
      const raw = (envStr('WIGOLO_AUTO_PASS', 'off', settings, 'autoPass') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    cdpDirect: (() => {
      const raw = (envStr('WIGOLO_CDP_DIRECT', 'off', settings, 'cdpDirect') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    aiSolve: (() => {
      const raw = (envStr('WIGOLO_AI_SOLVE', 'off', settings, 'aiSolve') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    aiSolveMaxAttempts: atLeast1(envInt('WIGOLO_AI_SOLVE_MAX_ATTEMPTS', 2, settings, 'aiSolveMaxAttempts')),
    humanSolve: (() => {
      const raw = (envStr('WIGOLO_HUMAN_SOLVE', 'off', settings, 'humanSolve') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    humanSolveTimeoutMs: envInt('WIGOLO_HUMAN_SOLVE_MS', 120000, settings, 'humanSolveTimeoutMs'),
    humanSolveConsent: envBool('WIGOLO_HUMAN_SOLVE_CONSENT', false, settings, 'humanSolveConsent'),
    scrapingBrowserWss: resolveCredentialUrl(
      envStr('WIGOLO_SCRAPING_BROWSER_WSS', null, settings, 'scrapingBrowserWss'),
      'scrapingBrowserWss',
    ),
    // The TLS-impersonation backend accepts a `<browser>_<version>` profile
    // string and forwards it into a Rust napi binding. Passing an unvalidated
    // value risks a panic / abort in native code if the env var is a typo
    // (`chrme_142`) or hostile input. Restrict to the documented wreq-js
    // browser families; on mismatch we warn (to stderr via the logger) and
    // fall back to the safe default.
    redditClientId: envStr('WIGOLO_REDDIT_CLIENT_ID', null, settings, 'redditClientId'),
    // Keychain-backed secret — resolved from env or OS keychain, never from
    // the (denylist-stripped) config.json.
    redditClientSecret: resolveKeychainSecret('WIGOLO_REDDIT_CLIENT_SECRET', 'redditClientSecret'),
    redditUserAgent:
      envStr('WIGOLO_REDDIT_USER_AGENT', null, settings, 'redditUserAgent') ?? DEFAULT_REDDIT_USER_AGENT,
    tlsBrowser: validateTlsBrowser(envStr('WIGOLO_TLS_BROWSER', null, settings, 'tlsBrowser'), 'chrome_142'),
    tlsSuccessThreshold: envInt('WIGOLO_TLS_SUCCESS_THRESHOLD', 3, settings, 'tlsSuccessThreshold'),
    tlsDomains: (() => {
      const raw = envStr('WIGOLO_TLS_DOMAINS', null, settings, 'tlsDomains');
      if (!raw) return [];
      return raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    })(),
  };

  // Apply the hardcore umbrella preset last: it flips the anti-bot / solve
  // knobs to their aggressive values, but only for knobs the operator did not
  // explicitly set (precedence: explicit knob > hardcore preset > default).
  applyHardcorePreset(cachedConfig, settings);

  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
  // Also reset the persisted-config cache so tests that change WIGOLO_CONFIG_PATH
  // or write fresh config files get a clean read on the next getConfig() call.
  resetPersistedConfig();
}
