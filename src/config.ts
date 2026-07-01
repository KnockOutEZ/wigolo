import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseBrowserTypes } from './fetch/browser-types.js';
import type { BrowserType } from './types.js';
import { readPersistedConfig, resetPersistedConfig, defaultConfigPath } from './persisted-config.js';

export interface Config {
  searxngUrl: string | null;
  searxngMode: 'native' | 'docker';
  searxngPort: number;
  fetchTimeoutMs: number;
  fetchMaxRetries: number;
  maxRedirects: number;
  playwrightLoadTimeoutMs: number;
  playwrightNavTimeoutMs: number;
  searxngQueryTimeoutMs: number;
  searchFetchTimeoutMs: number;
  searchFetchTimeoutBalancedMs: number;
  searchFetchTimeoutDeepMs: number;
  searchStageBudgetBalancedMs: number;
  searchStageBudgetDeepMs: number;
  searchTotalTimeoutMs: number;
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
  useProxy: boolean;
  proxyUrl: string | null;
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
   * TLS-impersonation HTTP tier mode:
   *   - 'off'  : tier disabled, current pipeline unchanged (DEFAULT)
   *   - 'auto' : only invoked on anti-bot signal (403/429/503 or challenge body)
   *   - 'on'   : tried first for cold domains, then HTTP, then Playwright
   */
  tlsTier: 'off' | 'auto' | 'on';
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
    playwrightLoadTimeoutMs: envInt('PLAYWRIGHT_LOAD_TIMEOUT_MS', 15000, settings, 'playwrightLoadTimeoutMs'),
    playwrightNavTimeoutMs: envInt('PLAYWRIGHT_NAV_TIMEOUT_MS', 30000, settings, 'playwrightNavTimeoutMs'),
    searxngQueryTimeoutMs: envInt('SEARXNG_QUERY_TIMEOUT_MS', 8000, settings, 'searxngQueryTimeoutMs'),
    searchFetchTimeoutMs: envInt('SEARCH_FETCH_TIMEOUT_MS', 15000, settings, 'searchFetchTimeoutMs'),
    searchFetchTimeoutBalancedMs: envInt('SEARCH_FETCH_TIMEOUT_BALANCED_MS', 3000, settings, 'searchFetchTimeoutBalancedMs'),
    searchFetchTimeoutDeepMs: envInt('SEARCH_FETCH_TIMEOUT_DEEP_MS', 8000, settings, 'searchFetchTimeoutDeepMs'),
    searchStageBudgetBalancedMs: envInt('SEARCH_STAGE_BUDGET_BALANCED_MS', 4000, settings, 'searchStageBudgetBalancedMs'),
    searchStageBudgetDeepMs: envInt('SEARCH_STAGE_BUDGET_DEEP_MS', 10000, settings, 'searchStageBudgetDeepMs'),
    searchTotalTimeoutMs: envInt('SEARCH_TOTAL_TIMEOUT_MS', 30000, settings, 'searchTotalTimeoutMs'),
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
    useProxy: envBool('USE_PROXY', false, settings, 'useProxy'),
    proxyUrl: envStr('PROXY_URL', null, settings, 'proxyUrl'),
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
    tlsTier: (() => {
      const raw = (envStr('WIGOLO_TLS_TIER', 'off', settings, 'tlsTier') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    // The TLS-impersonation backend accepts a `<browser>_<version>` profile
    // string and forwards it into a Rust napi binding. Passing an unvalidated
    // value risks a panic / abort in native code if the env var is a typo
    // (`chrme_142`) or hostile input. Restrict to the documented wreq-js
    // browser families; on mismatch we warn (to stderr via the logger) and
    // fall back to the safe default.
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

  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
  // Also reset the persisted-config cache so tests that change WIGOLO_CONFIG_PATH
  // or write fresh config files get a clean read on the next getConfig() call.
  resetPersistedConfig();
}
