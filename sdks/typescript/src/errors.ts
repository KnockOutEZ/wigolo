/**
 * Error hierarchy for the SDK. A non-2xx HTTP response becomes a
 * {@link WigoloApiError}; a transport-level failure (connection refused,
 * timeout, abort, DNS) becomes a {@link WigoloConnectionError}. A 200 response
 * is ALWAYS returned verbatim — even when it carries an in-body `error` or
 * `warning` field — and never throws.
 */

/** Base class for every error this SDK raises. */
export class WigoloError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WigoloError';
  }
}

/**
 * A non-2xx HTTP response. Carries the parsed error-envelope fields when the
 * body was a well-formed envelope; otherwise `error`/`error_reason`/`stage`
 * fall back to a raw body snippet.
 */
export class WigoloApiError extends WigoloError {
  /** HTTP status code. */
  readonly status: number;
  /** Human-readable error message from the envelope (or a raw body snippet). */
  readonly error: string | undefined;
  /** Stable machine reason code from the envelope. */
  readonly error_reason: string | undefined;
  /** Pipeline stage the failure occurred in, when the server reports one. */
  readonly stage: string | undefined;
  /** Parsed `Retry-After` header (seconds), present on 429 responses. */
  readonly retryAfter: number | undefined;

  constructor(init: {
    status: number;
    error?: string;
    error_reason?: string;
    stage?: string;
    retryAfter?: number;
  }) {
    const detail = init.error ?? init.error_reason ?? `HTTP ${init.status}`;
    super(`Wigolo request failed (${init.status}): ${detail}`);
    this.name = 'WigoloApiError';
    this.status = init.status;
    this.error = init.error;
    this.error_reason = init.error_reason;
    this.stage = init.stage;
    this.retryAfter = init.retryAfter;
  }
}

/**
 * A transport-level failure — the request never produced an HTTP response.
 * Connection-refused messages point at the zero-setup embedded-daemon path.
 */
export class WigoloConnectionError extends WigoloError {
  /** The underlying error, when one was raised. */
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WigoloConnectionError';
    this.cause = cause;
  }
}
