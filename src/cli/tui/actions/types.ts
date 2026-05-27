/**
 * Shared types for the SP3 actions layer.
 *
 * Every side-effecting action returns a typed result so the TUI can render
 * per-item success/failure and the headless path can surface the same info.
 */

// ---------------------------------------------------------------------------
// Component registry metadata (for Review/Toggles screen)
// ---------------------------------------------------------------------------

export type ComponentId =
  | 'searxng'
  | 'chromium'
  | 'firefox'
  | 'reranker'
  | 'embeddings';

export interface ComponentMeta {
  id: ComponentId;
  name: string;
  purpose: string;
  /** Human-readable estimate: disk + approx time */
  cost: string;
  /** Whether this component is enabled by default */
  defaultEnabled: boolean;
}

/** Ordered list used for both Review screen and toggle state initialisation. */
export const COMPONENT_REGISTRY: ComponentMeta[] = [
  {
    id: 'searxng',
    name: 'Search engine',
    purpose: 'Local search backend for web queries',
    cost: '~50 MB, ~30s',
    defaultEnabled: true,
  },
  {
    id: 'chromium',
    name: 'Chromium browser',
    purpose: 'Renders JS-heavy pages for fetch/crawl',
    cost: '~400 MB, ~2min',
    defaultEnabled: true,
  },
  {
    id: 'reranker',
    name: 'ML reranker',
    purpose: 'Re-orders search results by relevance',
    cost: '~100 MB, ~1min',
    defaultEnabled: true,
  },
  {
    id: 'embeddings',
    name: 'Embeddings model',
    purpose: 'Semantic search and find-similar',
    cost: '~90 MB, ~1min',
    defaultEnabled: true,
  },
];

/** Optional Firefox component added when browser=firefox */
export const FIREFOX_COMPONENT: ComponentMeta = {
  id: 'firefox',
  name: 'Firefox browser',
  purpose: 'Alternative privacy-focused browser engine',
  cost: '~300 MB, ~2min',
  defaultEnabled: false,
};

// ---------------------------------------------------------------------------
// Toggle state (Review/Toggles screen)
// ---------------------------------------------------------------------------

export type ToggleMap = Record<ComponentId, boolean>;

/** Build initial toggle state from COMPONENT_REGISTRY defaults. */
export function buildDefaultToggles(includeFirefox = false): ToggleMap {
  const map: ToggleMap = {} as ToggleMap;
  for (const c of COMPONENT_REGISTRY) {
    map[c.id] = c.defaultEnabled;
  }
  map['firefox'] = includeFirefox;
  return map;
}

// ---------------------------------------------------------------------------
// Write result (per-item commit reporting)
// ---------------------------------------------------------------------------

export type WriteStatus = 'ok' | 'failed' | 'skipped' | 'already_installed';

export interface WriteResult {
  id: string;
  label: string;
  status: WriteStatus;
  /** Human-readable path to what was written (config file, etc.) */
  path?: string;
  /** Error message if status === 'failed' */
  error?: string;
}

// ---------------------------------------------------------------------------
// Env/flags editor — curated subset
// ---------------------------------------------------------------------------

export type EnvGroupId =
  | 'search'
  | 'browser'
  | 'cache'
  | 'embedding'
  | 'logging';

export interface EnvVarMeta {
  /** Environment variable name (e.g. WIGOLO_SEARCH) */
  envKey: string;
  /** Settings key used in config.json (often same as envKey) */
  settingsKey: string;
  /** Group this var belongs to */
  group: EnvGroupId;
  /** Short display label */
  label: string;
  /** One-line description for the UI */
  description: string;
  /** Default value as a string */
  defaultValue: string;
  /** Allowed values for select-style vars; undefined = free-form string */
  options?: string[];
}

/**
 * Curated subset of WIGOLO_* vars exposed in the env/flags editor.
 *
 * Rationale for inclusions:
 *  - Search: WIGOLO_SEARCH (core/searxng/hybrid) — the most impactful toggle
 *  - Browser: WIGOLO_MAX_BROWSERS, WIGOLO_BROWSER_IDLE_TIMEOUT_MS — concurrency control
 *  - Cache: WIGOLO_DATA_DIR — lets user relocate the data dir
 *  - Cache TTLs: WIGOLO_CACHE_TTL_SEARCH, WIGOLO_CACHE_TTL_CONTENT
 *  - Embedding: WIGOLO_EMBEDDING_MODEL — model selection
 *  - Logging: WIGOLO_LOG_LEVEL — debug vs info vs warn
 *
 * Provider keys, Brave API key, GitHub token, and all numeric timeout
 * internals are deliberately excluded (SP4 owns provider; secrets never
 * go here; and exposing every timeout creates noise for 99% of users).
 */
export const CURATED_ENV_VARS: EnvVarMeta[] = [
  // — Search —
  {
    envKey: 'WIGOLO_SEARCH',
    settingsKey: 'WIGOLO_SEARCH',
    group: 'search',
    label: 'Search backend',
    description: 'core (default) | searxng | hybrid',
    defaultValue: 'core',
    options: ['core', 'searxng', 'hybrid'],
  },

  // — Browser —
  {
    envKey: 'WIGOLO_MAX_BROWSERS',
    settingsKey: 'WIGOLO_MAX_BROWSERS',
    group: 'browser',
    label: 'Max browser instances',
    description: 'Concurrent browser pages for JS-render (default: 3)',
    defaultValue: '3',
  },
  {
    envKey: 'WIGOLO_BROWSER_IDLE_TIMEOUT_MS',
    settingsKey: 'WIGOLO_BROWSER_IDLE_TIMEOUT_MS',
    group: 'browser',
    label: 'Browser idle timeout (ms)',
    description: 'Close idle browser instances after this delay (default: 30000)',
    defaultValue: '30000',
  },

  // — Cache —
  {
    envKey: 'WIGOLO_DATA_DIR',
    settingsKey: 'dataDir',
    group: 'cache',
    label: 'Data directory',
    description: 'Root path for cache, embeddings, models (default: ~/.wigolo)',
    defaultValue: '~/.wigolo',
  },
  {
    envKey: 'WIGOLO_CACHE_TTL_SEARCH',
    settingsKey: 'WIGOLO_CACHE_TTL_SEARCH',
    group: 'cache',
    label: 'Search cache TTL (ms)',
    description: 'How long search results are cached (default: 3600000 = 1 h)',
    defaultValue: '3600000',
  },
  {
    envKey: 'WIGOLO_CACHE_TTL_CONTENT',
    settingsKey: 'WIGOLO_CACHE_TTL_CONTENT',
    group: 'cache',
    label: 'Content cache TTL (ms)',
    description: 'How long fetched page content is cached (default: 86400000 = 24 h)',
    defaultValue: '86400000',
  },

  // — Embedding —
  {
    envKey: 'WIGOLO_EMBEDDING_MODEL',
    settingsKey: 'WIGOLO_EMBEDDING_MODEL',
    group: 'embedding',
    label: 'Embedding model',
    description: 'Sentence-transformers model name (default: all-MiniLM-L6-v2)',
    defaultValue: 'all-MiniLM-L6-v2',
  },

  // — Logging —
  {
    envKey: 'WIGOLO_LOG_LEVEL',
    settingsKey: 'WIGOLO_LOG_LEVEL',
    group: 'logging',
    label: 'Log level',
    description: 'debug | info | warn | error (default: info)',
    defaultValue: 'info',
    options: ['debug', 'info', 'warn', 'error'],
  },
];

export const ENV_GROUP_LABELS: Record<EnvGroupId, string> = {
  search: 'Search',
  browser: 'Browser',
  cache: 'Cache',
  embedding: 'Embedding',
  logging: 'Logging',
};

// ---------------------------------------------------------------------------
// Screen routing
// ---------------------------------------------------------------------------

export type ScreenId =
  | 'banner'
  | 'syscheck'
  | 'browser'
  | 'review'
  | 'install'
  | 'verify'
  | 'agents'
  | 'skills'
  | 'env-editor'
  | 'summary'
  | 'main-menu';

export type EntryMode = 'init' | 'config' | 'dashboard';
