/**
 * The consumer half of the REST `untrusted_content` envelope.
 *
 * The server has two representations for page-derived text (see the daemon's
 * `untrusted-mode.ts`). The DEFAULT is `inline`: the containment markers are woven into the
 * returned strings, so anything that concatenates them into a model's context is already safe.
 * The opt-in is `envelope`: the strings come back BYTE-CLEAN and the trust boundary travels
 * beside them as an `untrusted_content` sibling — for consumers that hash, dedup, index or
 * persist exactly what the site served, and that compose the fence only at the point some of
 * that text actually enters a model.
 *
 * `envelope` is only a control if something composes it. This module is that something: the
 * parts the server sends are assembled here, in the one order the server itself uses, so an SDK
 * consumer never hand-rolls the concatenation and never persists a fence by accident.
 *
 * Edge-safe: no `node:*` import, no crypto. The nonce is the SERVER's — an SDK-minted one would
 * be a second source of truth for a boundary the server already drew.
 */

/** Which representation a client asks the server for. Absent means the server default (`inline`). */
export type UntrustedContentMode = 'inline' | 'envelope';

/** Canonical spelling of the representation header. */
export const UNTRUSTED_CONTENT_HEADER = 'X-Wigolo-Untrusted-Content';

/**
 * The fence as data. Exactly the object the server puts on `untrusted_content` — field names are
 * the wire's (snake_case), not transliterated, so a mismatch is a wire change rather than a
 * spelling drift.
 */
export interface UntrustedContent {
  /** Always false: this metadata exists precisely because the payload is page-derived. */
  trusted: false;
  /** The instruction-channel statement — the region is data, never instructions. */
  notice: string;
  /** Per-response random nonce; both markers carry it. */
  nonce: string;
  begin_marker: string;
  end_marker: string;
  /** Resolved final URL of the page, when the server knew one. */
  origin?: string;
}

/** A response body that may carry the envelope beside its byte-clean payload. */
export type WithUntrustedContent<T> = T & { untrusted_content?: UntrustedContent };

/**
 * Stand-in for empty content, mirroring the server's own placeholder. An empty region reads to a
 * model as a malformed result; this says "the field was blank" explicitly.
 */
const EMPTY_PAYLOAD = '(empty)';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Read the envelope off a response, or `undefined` when there is none.
 *
 * Validates the load-bearing fields rather than trusting the shape: a half-formed envelope would
 * compose into a fence whose markers do not match, which is worse than no fence at all because it
 * LOOKS contained. `trusted` is not checked — the server documents it as ignored, and a consumer
 * that keyed on it would be reading a flag the producer says means nothing.
 */
export function untrustedContentOf(response: unknown): UntrustedContent | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  const candidate = (response as { untrusted_content?: unknown }).untrusted_content;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const parts = candidate as Record<string, unknown>;
  if (
    !isNonEmptyString(parts.notice) ||
    !isNonEmptyString(parts.nonce) ||
    !isNonEmptyString(parts.begin_marker) ||
    !isNonEmptyString(parts.end_marker)
  ) {
    return undefined;
  }
  return {
    trusted: false,
    notice: parts.notice,
    nonce: parts.nonce,
    begin_marker: parts.begin_marker,
    end_marker: parts.end_marker,
    ...(isNonEmptyString(parts.origin) ? { origin: parts.origin } : {}),
  };
}

/**
 * Compose the fence around one payload, in the server's order:
 * `notice \n begin_marker \n payload \n end_marker`.
 *
 * WRAP ONCE. The payload goes through byte-exact; passing already-fenced text nests two regions
 * and the inner terminator ends the outer one early. Fence at the moment the text enters a model,
 * never before it is persisted.
 */
export function fenceUntrusted(payload: string, parts: UntrustedContent): string {
  const body = payload.length > 0 ? payload : EMPTY_PAYLOAD;
  return `${parts.notice}\n${parts.begin_marker}\n${body}\n${parts.end_marker}`;
}

/**
 * The call site that works under BOTH representations, which is the point of it.
 *
 * With `untrustedContent: 'envelope'` the response carries the parts and the text is byte-clean,
 * so this composes them. Under the server default the text already carries its markers inline and
 * there is nothing to add, so it is returned verbatim — fencing it again would nest.
 *
 * A consumer therefore writes one line at the model boundary and does not branch on which mode it
 * asked for.
 */
export function fenceWithEnvelope(response: unknown, payload: string): string {
  const parts = untrustedContentOf(response);
  return parts ? fenceUntrusted(payload, parts) : payload;
}
