import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseBrowserTypes } from './fetch/browser-types.js';
import type { BrowserType } from './types.js';

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
  lightpandaUrl: string | null;
  lightpandaEnabled: boolean;
  lightpandaFailureThreshold: number;
  llmProvider: string | null;
  llmCacheTtlDays: number;
  llmMaxCallsPerRequest: number;
  /**
   * TLS-impersonation HTTP tier mode (slice D2):
   *   - 'off'  : tier disabled, current pipeline unchanged (DEFAULT)
   *   - 'auto' : only invoked on anti-bot signal (403/429/503 or challenge body)
   *   - 'on'   : tried first for cold domains, then HTTP, then Playwright
   */
  tlsTier: 'off' | 'auto' | 'on';
  /** Browser fingerprint profile passed to the TLS-impersonation backend. */
  tlsBrowser: string;
  /** Successes required before a domain is auto-promoted to TLS-first routing. */
  tlsSuccessThreshold: number;
}

function envStr(key: string, fallback: string | null = null): string | null {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function envIntArray(key: string, fallback: number[]): number[] {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parts = val.split(',').map(s => parseInt(s.trim(), 10));
  if (parts.some(n => isNaN(n))) return fallback;
  return parts;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() !== 'false' && val !== '0';
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

  cachedConfig = {
    searxngUrl: envStr('SEARXNG_URL'),
    searxngMode: (envStr('SEARXNG_MODE', 'native') as 'native' | 'docker'),
    searxngPort: envInt('SEARXNG_PORT', 8888),
    fetchTimeoutMs: envInt('FETCH_TIMEOUT_MS', 10000),
    fetchMaxRetries: envInt('FETCH_MAX_RETRIES', 2),
    maxRedirects: envInt('MAX_REDIRECTS', 5),
    playwrightLoadTimeoutMs: envInt('PLAYWRIGHT_LOAD_TIMEOUT_MS', 15000),
    playwrightNavTimeoutMs: envInt('PLAYWRIGHT_NAV_TIMEOUT_MS', 30000),
    searxngQueryTimeoutMs: envInt('SEARXNG_QUERY_TIMEOUT_MS', 8000),
    searchFetchTimeoutMs: envInt('SEARCH_FETCH_TIMEOUT_MS', 15000),
    searchTotalTimeoutMs: envInt('SEARCH_TOTAL_TIMEOUT_MS', 30000),
    validateTimeoutMs: envInt('VALIDATE_TIMEOUT_MS', 5000),
    maxBrowsers: envInt('MAX_BROWSERS', 3),
    browserIdleTimeoutMs: envInt('BROWSER_IDLE_TIMEOUT', 60000),
    browserFallbackThreshold: envInt('BROWSER_FALLBACK_THRESHOLD', 3),
    authStatePath: envStr('WIGOLO_AUTH_STATE_PATH'),
    chromeProfilePath: envStr('WIGOLO_CHROME_PROFILE_PATH'),
    cdpUrl: envStr('WIGOLO_CDP_URL') || null,
    dataDir: envStr('WIGOLO_DATA_DIR') ?? join(homedir(), '.wigolo'),
    cacheTtlSearch: envInt('CACHE_TTL_SEARCH', 86400),
    cacheTtlContent: envInt('CACHE_TTL_CONTENT', 604800),
    fastStaleMaxHours: envInt('WIGOLO_FAST_STALE_MAX_HOURS', 24),
    fastTimeoutMs: envInt('WIGOLO_FAST_TIMEOUT_MS', 800),
    crawlConcurrency: envInt('CRAWL_CONCURRENCY', 2),
    crawlDelayMs: envInt('CRAWL_DELAY_MS', 500),
    crawlPrivateConcurrency: envInt('CRAWL_PRIVATE_CONCURRENCY', 10),
    crawlPrivateDelayMs: envInt('CRAWL_PRIVATE_DELAY_MS', 0),
    useProxy: envBool('USE_PROXY', false),
    proxyUrl: envStr('PROXY_URL'),
    userAgent: envStr('USER_AGENT'),
    validateLinks: envBool('VALIDATE_LINKS', true),
    respectRobotsTxt: envBool('RESPECT_ROBOTS_TXT', true),
    braveApiKey: envStr('BRAVE_API_KEY'),
    githubToken: envStr('WIGOLO_GITHUB_TOKEN'),
    logLevel: (envStr('LOG_LEVEL', 'info') as Config['logLevel']),
    logFormat: (envStr('LOG_FORMAT', 'json') as Config['logFormat']),
    reranker: (() => {
      const raw = envStr('WIGOLO_RERANKER') ?? 'onnx';
      if (raw === 'flashrank') {
        console.warn(
          '[wigolo] WIGOLO_RERANKER=flashrank is a legacy alias; treating as onnx. ' +
          'The reranker runs as a Python subprocess; install via "wigolo warmup --reranker".',
        );
        return 'onnx';
      }
      return raw as Config['reranker'];
    })(),
    rerankerModel: envStr('WIGOLO_RERANKER_MODEL') ?? 'bge-reranker-v2-m3',
    rerankerMaxLength: envInt('WIGOLO_RERANKER_MAX_LENGTH', 512),
    rerankerReadyTimeoutMs: envInt('WIGOLO_RERANKER_READY_TIMEOUT_MS', 60_000),
    rerankerRequestTimeoutMs: envInt('WIGOLO_RERANKER_REQUEST_TIMEOUT_MS', 30_000),
    rerankerIdleTimeoutMs: envInt('WIGOLO_RERANKER_IDLE_TIMEOUT_MS', 300_000),
    relevanceThreshold: parseFloat(envStr('WIGOLO_RELEVANCE_THRESHOLD') ?? '0') || 0,
    findSimilarColdStartThreshold: (() => {
      const raw = envStr('WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD');
      if (raw === null || raw === undefined || raw === '') return 0.02;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 0.02;
    })(),
    bootstrapMaxAttempts: envInt('WIGOLO_BOOTSTRAP_MAX_ATTEMPTS', 3),
    bootstrapBackoffSeconds: envIntArray('WIGOLO_BOOTSTRAP_BACKOFF_SECONDS', [30, 3600, 86400]),
    healthProbeIntervalMs: envInt('WIGOLO_HEALTH_PROBE_INTERVAL_MS', 30000),
    daemonPort: envInt('WIGOLO_DAEMON_PORT', 3333),
    daemonHost: envStr('WIGOLO_DAEMON_HOST', '127.0.0.1')?.trim() || '127.0.0.1',
    pluginsDir: (() => {
      const raw = envStr('WIGOLO_PLUGINS_DIR');
      if (raw) {
        if (raw.startsWith('~')) return join(homedir(), raw.slice(1));
        return raw;
      }
      return join(envStr('WIGOLO_DATA_DIR') ?? join(homedir(), '.wigolo'), 'plugins');
    })(),
    browserTypes: parseBrowserTypes(envStr('WIGOLO_BROWSER_TYPES')),
    shellHistoryPath: envStr('WIGOLO_SHELL_HISTORY_PATH') ?? join(homedir(), '.wigolo', 'shell-history'),
    multiQueryConcurrency: envInt('WIGOLO_MULTI_QUERY_CONCURRENCY', 5),
    multiQueryMax: envInt('WIGOLO_MULTI_QUERY_MAX', 10),
    embeddingModel: envStr('WIGOLO_EMBEDDING_MODEL') ?? 'BAAI/bge-small-en-v1.5',
    embeddingIdleTimeoutMs: envInt('WIGOLO_EMBEDDING_IDLE_TIMEOUT', 1800000),
    embeddingMaxTextLength: envInt('WIGOLO_EMBEDDING_MAX_TEXT_LENGTH', 8000),
    lightpandaUrl: envStr('WIGOLO_LIGHTPANDA_URL'),
    lightpandaEnabled: envBool('WIGOLO_LIGHTPANDA_ENABLED', false),
    lightpandaFailureThreshold: envInt('WIGOLO_LIGHTPANDA_FAILURE_THRESHOLD', 3),
    llmProvider: envStr('WIGOLO_LLM_PROVIDER'),
    llmCacheTtlDays: envInt('WIGOLO_LLM_CACHE_TTL_DAYS', 7),
    llmMaxCallsPerRequest: envInt('WIGOLO_LLM_MAX_CALLS_PER_REQUEST', 1),
    tlsTier: (() => {
      const raw = (envStr('WIGOLO_TLS_TIER') ?? 'off').toLowerCase();
      return raw === 'auto' || raw === 'on' ? (raw as 'auto' | 'on') : 'off';
    })(),
    // The TLS-impersonation backend accepts a `<browser>_<version>` profile
    // string and forwards it into a Rust napi binding. Passing an unvalidated
    // value risks a panic / abort in native code if the env var is a typo
    // (`chrme_142`) or hostile input. Restrict to the documented wreq-js
    // browser families; on mismatch we warn (to stderr via the logger) and
    // fall back to the safe default.
    tlsBrowser: validateTlsBrowser(envStr('WIGOLO_TLS_BROWSER'), 'chrome_142'),
    tlsSuccessThreshold: envInt('WIGOLO_TLS_SUCCESS_THRESHOLD', 3),
  };

  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
