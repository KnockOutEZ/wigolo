import { homedir } from 'node:os';
import { join } from 'node:path';

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
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';
  trafilatura: 'auto' | 'always' | 'never';
  reranker: 'flashrank' | 'none' | 'custom';
  rerankerModel: string;
  relevanceThreshold: number;
  bootstrapMaxAttempts: number;
  bootstrapBackoffSeconds: number[];
  healthProbeIntervalMs: number;
  daemonPort: number;
  daemonHost: string;
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
    playwrightNavTimeoutMs: envInt('PLAYWRIGHT_NAV_TIMEOUT_MS', 10000),
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
    logLevel: (envStr('LOG_LEVEL', 'info') as Config['logLevel']),
    logFormat: (envStr('LOG_FORMAT', 'json') as Config['logFormat']),
    trafilatura: (envStr('WIGOLO_TRAFILATURA', 'auto') as 'auto' | 'always' | 'never'),
    reranker: (envStr('WIGOLO_RERANKER') ?? 'none') as Config['reranker'],
    rerankerModel: envStr('WIGOLO_RERANKER_MODEL') ?? 'ms-marco-MiniLM-L-12-v2',
    relevanceThreshold: parseFloat(envStr('WIGOLO_RELEVANCE_THRESHOLD') ?? '0') || 0,
    bootstrapMaxAttempts: envInt('WIGOLO_BOOTSTRAP_MAX_ATTEMPTS', 3),
    bootstrapBackoffSeconds: envIntArray('WIGOLO_BOOTSTRAP_BACKOFF_SECONDS', [30, 3600, 86400]),
    healthProbeIntervalMs: envInt('WIGOLO_HEALTH_PROBE_INTERVAL_MS', 30000),
    daemonPort: envInt('WIGOLO_DAEMON_PORT', 3333),
    daemonHost: envStr('WIGOLO_DAEMON_HOST', '127.0.0.1')?.trim() || '127.0.0.1',
  };

  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
