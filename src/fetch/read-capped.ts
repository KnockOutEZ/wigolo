/**
 * Thrown when a response body is larger than the configured cap
 * (`WIGOLO_MAX_RESPONSE_BYTES`). Carries a stable `code` so callers can surface
 * a `response_too_large` error instead of buffering the whole body and dying
 * with ERR_STRING_TOO_LONG / an OOM.
 */
export class ResponseTooLargeError extends Error {
  readonly code = 'response_too_large' as const;
  readonly hint = 'Raise WIGOLO_MAX_RESPONSE_BYTES if this response is expected to be this large';
  readonly retryable = false;
  /**
   * @param maxBytes The cap that was exceeded, in bytes.
   * @param url The URL whose response was too large, when known.
   */
  constructor(
    public readonly maxBytes: number,
    public readonly url?: string,
  ) {
    super(`Response body exceeds the ${maxBytes}-byte limit${url ? ` (${url})` : ''}`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * True when `err` is a response-size-cap failure. Matches on the `code` field
 * rather than `instanceof` so errors that crossed a module boundary still count.
 */
export function isResponseTooLarge(err: unknown): err is ResponseTooLargeError {
  return err instanceof Error && (err as Error & { code?: unknown }).code === 'response_too_large';
}

/** The parts of a fetch-style response this helper needs. */
export interface CappableResponse {
  /** Streamed body. Preferred, so the read can stop as soon as the cap is passed. */
  body?: ReadableStream<Uint8Array> | null;
  /** Fallback for responses without a stream. Buffers fully, then checks the size. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/**
 * Read a response body into a Buffer, failing once it passes `maxBytes`.
 *
 * Rejects early on a declared `content-length` over the cap, then streams the
 * body and aborts as soon as the running total crosses it, so a chunked
 * response with no declared length is bounded too. A `maxBytes` of 0 or less
 * disables the cap.
 *
 * `content-length` is the on-the-wire size. For a compressed response that is
 * normally smaller than the decoded body, so the early check can only let a
 * too-large body through to the streamed check, which measures decoded bytes.
 *
 * @param response A fetch-style response with a `body` stream or `arrayBuffer()`.
 * @param maxBytes Largest body to accept, in bytes. 0 or less disables the cap.
 * @param opts.contentLength The response's `content-length` header, if any.
 * @param opts.url Included in the error message when the cap is exceeded.
 * @returns The full body as a Buffer.
 * @throws {ResponseTooLargeError} When the body is larger than `maxBytes`.
 */
export async function readCapped(
  response: CappableResponse,
  maxBytes: number,
  opts: { contentLength?: string | null; url?: string } = {},
): Promise<Buffer> {
  const capped = Number.isFinite(maxBytes) && maxBytes > 0;

  if (capped && opts.contentLength) {
    const declared = Number(opts.contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      throw new ResponseTooLargeError(maxBytes, opts.url);
    }
  }

  const body = response.body;
  if (!body) {
    if (typeof response.arrayBuffer !== 'function') return Buffer.alloc(0);
    const buf = Buffer.from(await response.arrayBuffer());
    if (capped && buf.length > maxBytes) throw new ResponseTooLargeError(maxBytes, opts.url);
    return buf;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (capped && total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new ResponseTooLargeError(maxBytes, opts.url);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* cancelled or already released */ }
  }
  return Buffer.concat(chunks, total);
}
