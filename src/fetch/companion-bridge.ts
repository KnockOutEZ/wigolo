import type { RawFetchResult } from '../types.js';
import { readHandle, type SessionHandle } from '../companion/handle.js';
import {
  ESCALATION_ROUTE,
  STUDIO_FETCH_CAPABILITY,
  isEscalationDecline,
  isEscalationServed,
  type EscalationRequest,
  type EscalationResponse,
} from '../companion-contract/escalation.js';
import { bumpEscalationCounter } from '../companion/escalation-counters.js';
import { ensureStudioRunning } from '../companion/auto-launch.js';
import { COMPANION_TIMEOUT_MS, postCompanion } from '../companion/transport.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

/**
 * S9 — the core side of the companion escalation bridge.
 *
 * When the normal ladder terminates on a bot-protection challenge and a companion is paired, the page is
 * re-fetched through the human's real, attended browser instead. The bridge is gated on the published
 * handle: with no live companion it declines instantly and the caller keeps its honest
 * `blocked_by_challenge`.
 *
 * The transport is the shared companion POST (`companion/transport.ts`): the §4 escalation wire sent to the
 * endpoint the handle publishes, bearing the handle's token. This module owns only what is escalation-
 * specific — the route it addresses, which bodies count as an answer, and the counters.
 *
 * Every failure mode returns null (decline) rather than throwing, because this is an OPPORTUNISTIC rung:
 * a bridge problem must never turn a clean challenge report into a crash.
 */

/** The escalation transport: one POST, typed answer or null. Injectable so tests reach no socket. */
export type EscalationTransport = (
  handle: SessionHandle,
  request: EscalationRequest,
) => Promise<EscalationResponse | null>;

export interface CompanionBridgeDeps {
  dataDir?: string;
  /** Injectable for tests; production uses {@link postEscalation}. */
  call?: EscalationTransport;
  /** Amended-D4 auto-launch. Injectable so tests never spawn a real app. */
  ensureRunning?: (opts: { dataDir?: string }) => Promise<{ endpoint: string } | null>;
}

/**
 * POST the escalation request to the paired companion and return its typed answer.
 *
 * Returns null — never throws — for every transport-level failure: unreachable endpoint, timeout,
 * non-JSON body, or a body that satisfies neither arm of the wire. A well-formed decline IS returned,
 * because "the companion refused" and "the companion could not be reached" are different facts and the
 * counters distinguish them.
 *
 * The status code is deliberately NOT the gate: a companion that answers a refusal with 403 still owes a
 * typed decline body, and reading the body is what tells the two apart. Only a body that parses into
 * neither arm falls through to null.
 */
export async function postEscalation(
  handle: SessionHandle,
  request: EscalationRequest,
): Promise<EscalationResponse | null> {
  return postCompanion<EscalationResponse>(handle, {
    route: ESCALATION_ROUTE,
    body: request,
    timeoutMs: COMPANION_TIMEOUT_MS,
    accept: (parsed, httpOk) => {
      if (!httpOk && !isEscalationDecline(parsed)) return null;
      if (isEscalationServed(parsed) || isEscalationDecline(parsed)) return parsed;
      return null;
    },
  });
}

/** True when a companion has published a live handle — the rung's gate. */
export function companionBridgeAvailable(dataDir?: string): boolean {
  return readHandle(dataDir) !== null;
}

export async function companionBridgeFetch(url: string, deps: CompanionBridgeDeps = {}): Promise<RawFetchResult | null> {
  // Amended D4: if the substrate is not running, start it. Starting a process is not a consent event, and
  // the session it opens uses a clean in-memory profile — nothing of the human's is spent until D9's card
  // says so.
  const ensure = deps.ensureRunning ?? ensureStudioRunning;
  if (!companionBridgeAvailable(deps.dataDir) && !(await ensure({ dataDir: deps.dataDir }))) return null;
  const handle = readHandle(deps.dataDir);
  if (!handle) return null;
  // D10(a): count the attempt BEFORE it resolves, so a hang or crash still shows up as an attempt with no
  // corresponding serve. Counting only completed calls would make the served-rate look better than it is.
  bumpEscalationCounter('bridgeAttempted', deps.dataDir);

  const call = deps.call ?? postEscalation;
  const response = await call(handle, { capability: STUDIO_FETCH_CAPABILITY, url });
  if (response === null || !isEscalationServed(response)) {
    // A refusal (credential page, blocked navigation, no drive) is a legitimate answer, not a bug: the
    // caller falls through to its own challenge report. Logged at debug so it is diagnosable without
    // narrating a normal decline on every walled page.
    log.debug('companion escalation declined', {
      url,
      reason: response && isEscalationDecline(response) ? response.error_reason : 'transport_error',
    });
    bumpEscalationCounter('bridgeDeclined', deps.dataDir);
    return null;
  }
  bumpEscalationCounter('bridgeServed', deps.dataDir);

  const finalUrl = response.url !== '' ? response.url : url;
  return {
    url,
    finalUrl,
    html: response.html,
    contentType: 'text/html',
    statusCode: 200,
    // The bytes came off a real browser — the same `method` the browser tier reports, because for every
    // downstream consumer (cache staleness, research source filtering, completeness) that is what they are.
    method: 'browser',
    headers: {},
    escalated: true,
  };
}
