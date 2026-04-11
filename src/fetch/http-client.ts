import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

export interface HttpFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpFetchResult {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string;
  statusCode: number;
  headers: Record<string, string>;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']);
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
    // AbortSignal timeout throws DOMException with name TimeoutError
    if (err.name === 'TimeoutError') return true;
  }
  return false;
}

function backoffMs(attempt: number): number {
  return 500 * Math.pow(2, attempt) + Math.random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<HttpFetchResult> {
  const config = getConfig();
  const logger = createLogger('fetch');
  const maxRetries = config.fetchMaxRetries;
  const timeoutMs = options.timeoutMs ?? config.fetchTimeoutMs;
  const maxRedirects = config.maxRedirects;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = backoffMs(attempt - 1);
      logger.debug('retrying after backoff', { attempt, delayMs: delay, url });
      await sleep(delay);
    }

    try {
      const result = await fetchWithRedirects(url, options, timeoutMs, maxRedirects, logger);
      return result;
    } catch (err) {
      lastError = err;

      if (err instanceof HttpFetchError && !err.retryable) {
        throw err;
      }

      const retryable = err instanceof HttpFetchError ? err.retryable : isRetryableError(err);

      if (!retryable || attempt >= maxRetries) {
        throw err;
      }

      logger.warn('fetch failed, will retry', {
        attempt,
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw lastError;
}

class HttpFetchError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'HttpFetchError';
  }
}

async function fetchWithRedirects(
  originalUrl: string,
  options: HttpFetchOptions,
  timeoutMs: number,
  maxRedirects: number,
  logger: ReturnType<typeof createLogger>,
): Promise<HttpFetchResult> {
  const visited = new Set<string>();
  let currentUrl = originalUrl;
  let redirectCount = 0;

  while (true) {
    if (visited.has(currentUrl)) {
      throw new HttpFetchError(`Redirect loop detected at ${currentUrl}`, false);
    }
    visited.add(currentUrl);

    logger.debug('fetching', { url: currentUrl, attempt: redirectCount });

    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: options.headers,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const isConnErr = err instanceof Error && RETRYABLE_ERROR_CODES.has((err as NodeJS.ErrnoException).code ?? '');
      const retryable = isTimeout || isConnErr;
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { retryable });
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new HttpFetchError(`Redirect with no location header at ${currentUrl}`, false);
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new HttpFetchError(`Too many redirects (>${maxRedirects}) from ${originalUrl}`, false);
      }

      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      throw new HttpFetchError(`HTTP ${response.status} from ${currentUrl}`, true);
    }

    const html = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      url: originalUrl,
      finalUrl: currentUrl,
      html,
      contentType,
      statusCode: response.status,
      headers,
    };
  }
}
