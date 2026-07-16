/**
 * Thin REST client for a running wigolo daemon. One method per tool — each
 * POSTs its params object verbatim to the manifest path — plus the GET-based
 * `health()`, `listTools()`, `openapi()`. NO retries, re-ranking,
 * interpretation, or caching: a 200 body is returned exactly as received (even
 * with an in-body `error`/`warning`); a non-2xx becomes a typed error.
 *
 * This module is edge-safe: it imports no `node:*` builtin. Spawning a local
 * daemon lives in the `./local` subpath.
 */
import { manifest, type ToolName } from './manifest.js';
import { WigoloApiError, WigoloConnectionError } from './errors.js';
import type {
  CallOptions,
  HealthResponse,
  SearchRequest,
  SearchResponse,
  FetchRequest,
  FetchResponse,
  CrawlRequest,
  CrawlResponse,
  CacheRequest,
  CacheResponse,
  ExtractRequest,
  ExtractResponse,
  FindSimilarRequest,
  FindSimilarResponse,
  ResearchRequest,
  ResearchResponse,
  AgentRequest,
  AgentResponse,
  DiffRequest,
  DiffResponse,
  WatchRequest,
  WatchResponse,
} from './types.js';

/** A `fetch`-compatible function; injectable for tests. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface WigoloClientOptions {
  /** Base URL of the daemon. Default resolution: option > WIGOLO_BASE_URL > http://127.0.0.1:3333. */
  baseUrl?: string;
  /** Bearer token. Default resolution: option > WIGOLO_API_TOKEN. Omit for open mode. */
  token?: string;
  /** Default per-request deadline (ms). Overrides the per-tool manifest default. */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests / custom transports). */
  fetch?: FetchLike;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3333';

/**
 * Read an env var without ever throwing. Deno exposes `process` but denies env
 * access with a NotCapable throw absent `--allow-env`; a Worker may lack
 * `process` entirely. Either case yields undefined, not a crash.
 */
function readEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = proc?.env?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Combine two abort signals into one that aborts when either does. */
function combineSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  // Manual fallback: a fresh controller aborted by whichever fires first.
  const controller = new AbortController();
  const onAbort = (reason: unknown): void => controller.abort(reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener('abort', () => onAbort(a.reason), { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener('abort', () => onAbort(b.reason), { once: true });
  return controller.signal;
}

/** Join a base URL and an absolute path, tolerating a trailing slash on the base. */
function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/** Parse a case-insensitive `Retry-After` header as integer seconds. */
function parseRetryAfter(headers: { get(name: string): string | null }): number | undefined {
  const raw = headers.get('retry-after') ?? headers.get('Retry-After');
  if (!raw) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

export class WigoloClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: WigoloClientOptions = {}) {
    // Env is NOT read when the option is explicit.
    this.baseUrl =
      options.baseUrl !== undefined
        ? options.baseUrl
        : readEnv('WIGOLO_BASE_URL') ?? DEFAULT_BASE_URL;
    this.token = options.token !== undefined ? options.token : readEnv('WIGOLO_API_TOKEN');
    this.defaultTimeoutMs = options.timeoutMs;
    const injected = options.fetch;
    if (injected) {
      this.fetchImpl = injected;
    } else {
      const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
      if (!globalFetch) {
        throw new Error(
          'No fetch implementation available. Pass { fetch } to the WigoloClient options, ' +
            'or run on a runtime with a global fetch (Node >=18).',
        );
      }
      this.fetchImpl = globalFetch;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private effectiveTimeout(tool: ToolName, call: CallOptions | undefined): number {
    if (call?.timeoutMs !== undefined) return call.timeoutMs;
    if (this.defaultTimeoutMs !== undefined) return this.defaultTimeoutMs;
    return manifest[tool].defaultTimeoutMs;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    call: CallOptions | undefined,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = combineSignals(timeoutSignal, call?.signal);
    const url = joinUrl(this.baseUrl, path);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      throw this.connectionError(err);
    }

    if (!response.ok) {
      throw await this.apiError(response);
    }

    // 2xx — return verbatim, even when the body carries in-band error/warning.
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 2xx with a non-JSON body is unexpected; surface it as a connection error.
      throw new WigoloConnectionError(
        `Received a non-JSON success body from ${url} (${text.slice(0, 200)})`,
      );
    }
  }

  private async apiError(response: Awaited<ReturnType<FetchLike>>): Promise<WigoloApiError> {
    const retryAfter = parseRetryAfter(response.headers);
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as {
          error?: unknown;
          error_reason?: unknown;
          stage?: unknown;
        };
        return new WigoloApiError({
          status: response.status,
          error: typeof parsed.error === 'string' ? parsed.error : undefined,
          error_reason: typeof parsed.error_reason === 'string' ? parsed.error_reason : undefined,
          stage: typeof parsed.stage === 'string' ? parsed.stage : undefined,
          retryAfter,
        });
      } catch {
        // Fall through to raw-snippet path.
      }
    }
    return new WigoloApiError({
      status: response.status,
      error: text.length > 0 ? text.slice(0, 500) : undefined,
      retryAfter,
    });
  }

  private connectionError(err: unknown): WigoloConnectionError {
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'TimeoutError') {
      return new WigoloConnectionError(`Request to ${this.baseUrl} timed out.`, err);
    }
    if (name === 'AbortError') {
      return new WigoloConnectionError(`Request to ${this.baseUrl} was aborted.`, err);
    }
    const looksRefused = /ECONNREFUSED|connect|refused|fetch failed/i.test(message);
    if (looksRefused) {
      return new WigoloConnectionError(
        `Could not reach a wigolo daemon at ${this.baseUrl} (${message}). ` +
          'Start one with `wigolo serve`, or use `createLocalClient` from "@wigolo/sdk/local" ' +
          'to launch and manage a local daemon automatically.',
        err,
      );
    }
    return new WigoloConnectionError(
      `Request to ${this.baseUrl} failed at the transport layer (${message}).`,
      err,
    );
  }

  private post<Req, Res>(tool: ToolName, params: Req, call?: CallOptions): Promise<Res> {
    return this.request<Res>('POST', manifest[tool].path, params, this.effectiveTimeout(tool, call), call);
  }

  // ---- tool methods (bound arrow fields; destructuring-safe) ----

  search = (params: SearchRequest, call?: CallOptions): Promise<SearchResponse> =>
    this.post<SearchRequest, SearchResponse>('search', params, call);

  fetch = (params: FetchRequest, call?: CallOptions): Promise<FetchResponse> =>
    this.post<FetchRequest, FetchResponse>('fetch', params, call);

  crawl = (params: CrawlRequest, call?: CallOptions): Promise<CrawlResponse> =>
    this.post<CrawlRequest, CrawlResponse>('crawl', params, call);

  cache = (params: CacheRequest = {}, call?: CallOptions): Promise<CacheResponse> =>
    this.post<CacheRequest, CacheResponse>('cache', params, call);

  extract = (params: ExtractRequest = {}, call?: CallOptions): Promise<ExtractResponse> =>
    this.post<ExtractRequest, ExtractResponse>('extract', params, call);

  findSimilar = (params: FindSimilarRequest = {}, call?: CallOptions): Promise<FindSimilarResponse> =>
    this.post<FindSimilarRequest, FindSimilarResponse>('find_similar', params, call);

  research = (params: ResearchRequest, call?: CallOptions): Promise<ResearchResponse> =>
    this.post<ResearchRequest, ResearchResponse>('research', params, call);

  agent = (params: AgentRequest, call?: CallOptions): Promise<AgentResponse> =>
    this.post<AgentRequest, AgentResponse>('agent', params, call);

  diff = (params: DiffRequest = {}, call?: CallOptions): Promise<DiffResponse> =>
    this.post<DiffRequest, DiffResponse>('diff', params, call);

  watch = (params: WatchRequest, call?: CallOptions): Promise<WatchResponse> =>
    this.post<WatchRequest, WatchResponse>('watch', params, call);

  // ---- infrastructure GETs ----

  /** GET /health — open even in token mode. 200 up / 503 down (both parsed). */
  health = async (call?: CallOptions): Promise<HealthResponse> => {
    // /health returns 503 with the SAME shape when down; treat that as a value,
    // not an error, so callers can inspect the report.
    const timeoutSignal = AbortSignal.timeout(call?.timeoutMs ?? this.defaultTimeoutMs ?? 5000);
    const signal = combineSignals(timeoutSignal, call?.signal);
    const url = joinUrl(this.baseUrl, '/health');
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers: this.headers(), signal });
    } catch (err) {
      throw this.connectionError(err);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as HealthResponse;
    } catch {
      throw new WigoloConnectionError(`Received a non-JSON /health body from ${url}.`);
    }
  };

  /** GET /v1/tools — bearer-gated in token mode. */
  listTools = (call?: CallOptions): Promise<unknown> =>
    this.request<unknown>('GET', '/v1/tools', undefined, call?.timeoutMs ?? this.defaultTimeoutMs ?? 30000, call);

  /** GET /openapi.json — bearer-gated in token mode. */
  openapi = (call?: CallOptions): Promise<unknown> =>
    this.request<unknown>('GET', '/openapi.json', undefined, call?.timeoutMs ?? this.defaultTimeoutMs ?? 30000, call);
}
