import { SSRF_CODES, type SsrfCode } from '../../watch/ssrf.js';

/**
 * REST error envelope + HTTP status mapping. Every non-200 response carries the
 * full envelope in the body. Status is keyed on exact codes/stages — NEVER a
 * substring scan of free text (a reason sentence containing "timeout" must not
 * map to 504; 504 only comes from the route-deadline path).
 */

export interface ErrorEnvelope {
  ok: false;
  error: string;
  error_reason: string;
  stage?: string;
  hint?: string;
}

export interface HttpError {
  status: number;
  body: ErrorEnvelope;
  headers: Record<string, string>;
}

export function errorEnvelope(
  error_reason: string,
  error: string,
  extra: { stage?: string; hint?: string } = {},
): ErrorEnvelope {
  return {
    ok: false,
    error,
    error_reason,
    ...(extra.stage ? { stage: extra.stage } : {}),
    ...(extra.hint ? { hint: extra.hint } : {}),
  };
}

function err(
  status: number,
  reason: string,
  error: string,
  extra: { stage?: string; hint?: string } = {},
  headers: Record<string, string> = {},
): HttpError {
  return { status, body: errorEnvelope(reason, error, extra), headers };
}

export function invalidJson(): HttpError {
  return err(400, 'invalid_json', 'Request body is not valid JSON', {
    stage: 'parse',
    hint: 'Send a JSON object matching the tool input schema.',
  });
}

export function invalidInput(detail: string): HttpError {
  return err(400, 'invalid_input', detail, { stage: 'validate' });
}

export function unauthorized(hint: string): HttpError {
  return err(401, 'unauthorized', 'Missing or invalid bearer token', { hint });
}

export function forbidden(reason: string, hint: string): HttpError {
  return err(403, reason, 'Request forbidden', { hint });
}

export function notFound(): HttpError {
  return err(404, 'not_found', 'No such route', {
    hint: 'See GET /v1/tools for the available endpoints.',
  });
}

export function methodNotAllowed(allow: string): HttpError {
  return err(405, 'method_not_allowed', `Method not allowed; use ${allow}`, {}, { Allow: allow });
}

export function bodyTooLarge(capBytes: number): HttpError {
  return err(413, 'body_too_large', 'Request body exceeds the size cap', {
    hint: `The body cap for this route is ${capBytes} bytes. Set WIGOLO_SERVE_MAX_BODY_BYTES to raise it.`,
  });
}

export function tooManyRequests(): HttpError {
  return err(
    429,
    'too_many_requests',
    'The server has too many in-flight requests',
    { hint: 'Retry after a short delay; concurrency is bounded by WIGOLO_SERVE_MAX_CONCURRENCY.' },
    { 'Retry-After': '5' },
  );
}

export function internalError(): HttpError {
  return err(500, 'internal_error', 'Internal server error');
}

export function notImplemented(tool: string): HttpError {
  return err(501, 'not_implemented', `The ${tool} route is not implemented yet`, {
    stage: 'dispatch',
  });
}

export function routeTimeout(tool: string): HttpError {
  return err(504, 'route_timeout', `The ${tool} route exceeded its deadline`, {
    stage: 'dispatch',
    hint: 'Reduce the request scope or raise WIGOLO_SERVE_TIMEOUT_SCALE.',
  });
}

// ── StageResult status mapping ──────────────────────────────────────────────

/** Exact unavailability reason codes → 503. */
const UNAVAILABILITY_REASONS = new Set(['browser_engine_unavailable', 'search_backend_unavailable']);

/** Exact fetch-stage upstream failure reason codes → 502. */
const FETCH_UPSTREAM_REASONS = new Set(['blocked_by_challenge', 'fetch_failed', 'upstream_error', 'http_error']);

/** Explicit (stage, reason) semantic-validation allowlist → 400. */
const SEMANTIC_VALIDATION_REASONS = new Set([
  'invalid_url',
  'invalid_input',
  'invalid_schema',
  'invalid_mode',
  'missing_required_field',
  'unsupported_scheme',
]);

export interface StageFailure {
  error: string;
  error_reason: string;
  stage: string;
}

/**
 * Map a StageResult failure to an HTTP status. Conservative + table-driven:
 * 503 for known unavailability, 502 for fetch-stage upstream failures, 400 for
 * the explicit semantic-validation allowlist, else 500. Never substring-scans.
 */
export function statusForStageResult(f: StageFailure): number {
  if (UNAVAILABILITY_REASONS.has(f.error_reason)) return 503;
  if (f.stage === 'fetch' && FETCH_UPSTREAM_REASONS.has(f.error_reason)) return 502;
  if (SEMANTIC_VALIDATION_REASONS.has(f.error_reason)) return 400;
  return 500;
}

const SSRF_CODE_SET = new Set<string>(Object.values(SSRF_CODES) as SsrfCode[]);

/**
 * Map a crawl/cache in-band error to an HTTP status. The value passed is either
 * a stable ssrf code (→ 400) or an upstream fetch reason code (→ 502); anything
 * else (free-text messages) → 500. No substring matching.
 */
export function statusForCrawlCacheError(errorKey: string): number {
  if (SSRF_CODE_SET.has(errorKey)) return 400;
  if (FETCH_UPSTREAM_REASONS.has(errorKey)) return 502;
  return 500;
}

/**
 * Search returns `ok:true` with an optional `data.error`. A set `error`
 * (all-engines-failed) is mapped like a failure (500). A `warning`-only /
 * degraded result stays 200 → return null (no remap).
 */
export function statusForSearchData(data: { error?: unknown; warning?: unknown }): number | null {
  if (data && typeof data.error === 'string' && data.error.length > 0) return 500;
  return null;
}
