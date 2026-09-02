import type { SessionHandle } from './handle.js';
import { createLogger } from '../logger.js';

const log = createLogger('companion');

/**
 * The one HTTP client every companion-contract wire rides.
 *
 * Each wire in `companion-contract/` owns a SHAPE and performs no I/O. This owns the matching transport and
 * knows nothing about any shape: one POST of a JSON body to a route on the endpoint the companion published
 * in its handle file, bearing that handle's token — the same trust-on-file bootstrap the old proxy used,
 * minus the proxy. It rides no MCP client and no tool dispatch on purpose: these capabilities are not tools,
 * the companion is not required to be an MCP server to answer them, and core must be able to speak them with
 * the domain layer extracted out of the repo entirely.
 *
 * It returns null — never throws — for every transport-level failure: unreachable endpoint, timeout,
 * non-JSON body, or a body that satisfies no arm of the wire. Its callers are opportunistic rungs and tool
 * dispatch arms, where a transport fault must degrade to a typed answer rather than a crash. What counts as
 * a valid answer is the WIRE's business, not this module's, so each caller passes {@link CompanionPost.accept}.
 */

/** Ceiling on one companion round-trip, shared by the wires.
 *
 * Anchored to the §7 approval ceiling: a pending approval auto-denies after 2 minutes, so a companion that
 * has not answered inside that window is not "still deciding" — there is nothing left on the other side to
 * wait for. Reversal condition: if the companion ever answers behind a human-solve step allowed to outlive
 * the approval ceiling, this and that ceiling move together.
 */
export const COMPANION_TIMEOUT_MS = 120_000;

export interface CompanionPost<T> {
  /** Route appended to the endpoint the handle publishes (the wire owns the constant). */
  route: string;
  /** Request body, JSON-encoded as-is. */
  body: unknown;
  /**
   * Read the parsed body into this wire's typed answer, or null when it satisfies no arm.
   *
   * `httpOk` is handed in rather than gating the call, because the status is NOT the gate: a companion that
   * answers a refusal with 403 or 404 still owes a typed refusal body, and reading the body is what tells
   * "the companion refused" apart from "no companion answered" — a distinction the callers' counters and
   * error text depend on. Only a body that satisfies no arm falls through to null.
   */
  accept: (parsed: unknown, httpOk: boolean) => T | null;
  /** Ceiling on the round-trip; defaults to {@link COMPANION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Endpoints are published as a base URL (`http://127.0.0.1:PORT`); tolerate a trailing slash anyway. */
function routeUrl(endpoint: string, route: string): string {
  return `${endpoint.replace(/\/+$/, '')}${route}`;
}

export async function postCompanion<T>(handle: SessionHandle, post: CompanionPost<T>): Promise<T | null> {
  let parsed: unknown;
  let httpOk: boolean;
  try {
    const response = await fetch(routeUrl(handle.endpoint, post.route), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handle.token}`,
      },
      body: JSON.stringify(post.body),
      signal: AbortSignal.timeout(post.timeoutMs ?? COMPANION_TIMEOUT_MS),
    });
    httpOk = response.ok;
    parsed = await response.json();
  } catch (err) {
    log.debug('companion transport failed', {
      endpoint: handle.endpoint,
      route: post.route,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return post.accept(parsed, httpOk);
}
