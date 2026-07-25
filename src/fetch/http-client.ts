import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { anySignal } from '../util/abort.js';
import { guardFetchUrl, guardResolvedHost } from '../watch/ssrf.js';

export interface HttpFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  conditionalHeaders?: {
    ifNoneMatch?: string;
    ifModifiedSince?: string;
  };
  signal?: AbortSignal;
  /**
   * Whether private/LAN redirect targets are permitted. Defaults to the
   * resolved `WIGOLO_FETCH_ALLOW_PRIVATE` config so the redirect re-guard uses
   * the same policy the input URL was guarded under. Link-local / metadata
   * targets stay blocked regardless.
   */
  allowPrivate?: boolean;
}

export interface HttpFetchResult {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string;
  statusCode: number;
  headers: Record<string, string>;
  rawBuffer?: Buffer;
}

// The leading bytes of every PDF file. Used to recognise a PDF that a server
// served with a generic/absent content-type so the byte tier buffers it.
const PDF_MAGIC = '%PDF-';

function bufferLooksLikePdf(buf: Buffer): boolean {
  return buf.length >= PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}

/** True when both URLs resolve to the same hostname (host-equality, not eTLD+1).
 *  Malformed inputs are treated as different hosts (fail closed). */
function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']);
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function getRotatingUserAgent(config: { userAgent?: string | null }): string {
  if (config.userAgent) return config.userAgent;
  return DEFAULT_USER_AGENTS[Math.floor(Math.random() * DEFAULT_USER_AGENTS.length)];
}

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<HttpFetchResult> {
  const config = getConfig();
  const logger = createLogger('fetch');
  const maxRetries = config.fetchMaxRetries;
  const timeoutMs = options.timeoutMs ?? config.fetchTimeoutMs;
  const maxRedirects = config.maxRedirects;
  const allowPrivate = options.allowPrivate ?? config.fetchAllowPrivate;
  const external = options.signal;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (external?.aborted) throw external.reason;

    if (attempt > 0) {
      const delay = backoffMs(attempt - 1);
      logger.debug('retrying after backoff', { attempt, delayMs: delay, url });
      await sleep(delay, external);
    }

    try {
      const result = await fetchWithRedirects(url, options, timeoutMs, maxRedirects, allowPrivate, logger);
      return result;
    } catch (err) {
      if (external?.aborted) throw external.reason;

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
  allowPrivate: boolean,
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

    // Fetch-time SSRF re-check. `guardFetchUrl` (applied on input + each redirect
    // Location) only validates the LITERAL host, so a public hostname whose DNS
    // record points at a blocked address (cloud metadata / RFC-1918 / loopback in
    // serve mode) passes it and is only caught here, before we connect. Skip literal
    // IPs — already validated. Same allowPrivate policy as the literal guard.
    {
      const rhost = new URL(currentUrl).hostname;
      const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(rhost) || rhost.includes(':');
      if (!isIpLiteral) {
        const resolved = await guardResolvedHost(rhost, 'target url', {
          allowPrivate,
        });
        if (!resolved.ok) {
          throw new HttpFetchError(resolved.reason, false);
        }
      }
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = options.signal
      ? anySignal([options.signal, timeout])
      : { signal: timeout, cleanup: () => {} };
    const signal = combined.signal;

    let response: Response;
    try {
      const ua = getRotatingUserAgent(getConfig());
      const mergedHeaders: Record<string, string> = { 'User-Agent': ua, ...options.headers };
      // Never carry a Cookie across a cross-host redirect hop. A reused anti-bot
      // clearance cookie is host-scoped; leaking it to a different host on a 3xx
      // would send a credential to an unintended origin.
      if (!isSameHost(originalUrl, currentUrl)) {
        delete mergedHeaders['Cookie'];
        delete mergedHeaders['cookie'];
      }
      // Conditional GET: inject If-None-Match / If-Modified-Since so the
      // server can return 304 + no body when the resource hasn't changed.
      // Callers (eg. etag-incremental crawl) wire these from the persisted
      // crawl_etags row for the URL.
      if (options.conditionalHeaders?.ifNoneMatch) {
        mergedHeaders['If-None-Match'] = options.conditionalHeaders.ifNoneMatch;
      }
      if (options.conditionalHeaders?.ifModifiedSince) {
        mergedHeaders['If-Modified-Since'] = options.conditionalHeaders.ifModifiedSince;
      }
      response = await fetch(currentUrl, {
        headers: mergedHeaders,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const isConnErr = err instanceof Error && RETRYABLE_ERROR_CODES.has((err as NodeJS.ErrnoException).code ?? '');
      const retryable = isTimeout || isConnErr;
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { retryable });
    } finally {
      combined.cleanup();
    }

    if (response.status === 304) {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      // Drain so the connection can be released; ignore the (empty) body.
      try { await response.arrayBuffer(); } catch { /* */ }
      return {
        url: originalUrl,
        finalUrl: currentUrl,
        html: '',
        contentType: response.headers.get('content-type') ?? '',
        statusCode: 304,
        headers,
      };
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

      // SSRF re-guard on EVERY resolved redirect target — a public URL must
      // not be able to 302 the fetch onto a private/LAN host or a cloud
      // metadata endpoint. Same policy the input URL was guarded under.
      const redirectGuard = guardFetchUrl(currentUrl, 'redirect location', { allowPrivate });
      if (!redirectGuard.ok) {
        throw new HttpFetchError(
          `Redirect blocked: ${redirectGuard.reason}. ${redirectGuard.hint}`,
          false,
        );
      }
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      throw new HttpFetchError(`HTTP ${response.status} from ${currentUrl}`, true);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const declaredPdf = contentType.includes('application/pdf');
    // An ambiguous content-type (generic binary or none) may still be a PDF
    // served without the right header. Sniff the body's magic bytes so those
    // are buffered like a declared PDF instead of being decoded to garbage
    // text. HTML/JSON/text/xml responses are never sniffed — they decode as
    // before with no extra buffering.
    const ambiguousType = contentType === '' || contentType.includes('application/octet-stream');
    let html: string;
    let rawBuffer: Buffer | undefined;
    // Normalised so a magic-bytes PDF is reported as application/pdf to the
    // extractor (which keys PDF handling on the content-type).
    let effectiveContentType = contentType;

    if (declaredPdf) {
      const arrayBuf = await response.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuf);
      html = '';
    } else if (ambiguousType) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (bufferLooksLikePdf(buf)) {
        rawBuffer = buf;
        html = '';
        effectiveContentType = 'application/pdf';
      } else {
        html = buf.toString('utf-8');
      }
    } else {
      html = await response.text();
    }

    return {
      url: originalUrl,
      finalUrl: currentUrl,
      html,
      contentType: effectiveContentType,
      statusCode: response.status,
      headers,
      rawBuffer,
    };
  }
}
