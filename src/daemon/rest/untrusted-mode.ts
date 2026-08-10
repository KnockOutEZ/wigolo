/**
 * WHERE THE TRUST BOUNDARY TRAVELS ON A REST RESPONSE — one mechanism, two defaults.
 *
 * Page-derived text is DATA, never instructions. On the MCP surface the containment fence is woven
 * into the strings themselves (src/server/content-fence.ts). REST has two populations of consumer and
 * only one of them wants that:
 *
 *  - `inline`   — the markers are INSIDE the returned strings, exactly as an MCP consumer receives
 *                 them. Safe for anything that concatenates the text into a model's context, which is
 *                 what curl, a shell script, and any third-party framework do by default.
 *  - `envelope` — the payload is BYTE-CLEAN and the boundary travels as sibling metadata
 *                 (`untrusted_content`: notice + nonce + both markers). For consumers that persist,
 *                 hash or index the text, and that compose the fence themselves at the point the text
 *                 actually enters a model.
 *
 * CEO ruling R2 (decision A10): `inline` is the DEFAULT on the native `/v1/{tool}` routes and
 * `envelope` is the explicit opt-in. The earlier default was the other way round on the reasoning that
 * our own SDK helpers would assemble the envelope — but an SDK helper only protects SDK users, and the
 * naive concatenator outside our SDKs had no way to ask for safety. The unsafe representation is the
 * one that must be requested.
 *
 * Decision A11: `/compat/firecrawl/*` carries the INVERSE default — see the loud note in
 * firecrawl-compat.ts. Same header, same values; only the fallback differs.
 *
 * A HEADER rather than a request-body field, deliberately:
 *  - it is a REPRESENTATION choice about the response, the same class of thing as `Accept`; it is not
 *    an argument to the tool and must never reach a tool handler or a persisted input;
 *  - the ten tool bodies are JSON-Schema validated (validate.ts) against the SAME schemas the MCP
 *    surface publishes, so a body field would have to be added to all ten and would leak into the MCP
 *    tool contract, where it means nothing;
 *  - it applies uniformly to routes that take no body at all (the compat crawl-status GET).
 */

export type UntrustedMode = 'inline' | 'envelope';

/** Lowercase — node lowercases incoming header names, and this is compared against that map. */
export const UNTRUSTED_MODE_HEADER = 'x-wigolo-untrusted-content';

/** The canonical spelling, for docs and error hints. */
export const UNTRUSTED_MODE_HEADER_NAME = 'X-Wigolo-Untrusted-Content';

const MODES: readonly UntrustedMode[] = ['inline', 'envelope'];

export type UntrustedModeResolution =
  | { ok: true; mode: UntrustedMode }
  | { ok: false; value: string; hint: string };

/**
 * Resolve the response representation for one request.
 *
 * An absent header takes the surface's `fallback`. A recognized value wins. An UNRECOGNIZED value is
 * REFUSED (400) rather than silently falling back: the header exists only because a caller typed it,
 * so a typo is a caller mistake worth surfacing, and on the compat surface a silent fallback would
 * hand back the unsafe representation to someone who had just asked for the safe one.
 *
 * Case-insensitive and whitespace-tolerant; a repeated header (node yields `string[]`) is refused
 * rather than guessed at.
 */
export function resolveUntrustedMode(
  raw: string | string[] | undefined,
  fallback: UntrustedMode,
): UntrustedModeResolution {
  if (raw === undefined) return { ok: true, mode: fallback };
  if (Array.isArray(raw)) {
    return {
      ok: false,
      value: raw.join(', '),
      hint: `Send ${UNTRUSTED_MODE_HEADER_NAME} at most once.`,
    };
  }
  const value = raw.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(value)) {
    return { ok: true, mode: value as UntrustedMode };
  }
  return {
    ok: false,
    value: raw,
    hint: `${UNTRUSTED_MODE_HEADER_NAME} accepts "inline" (containment markers inside the returned text) or "envelope" (byte-clean text plus an untrusted_content metadata sibling).`,
  };
}
