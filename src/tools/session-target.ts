import type { CrawlInput, CrawlOutput, ExtractInput, ExtractOutput, FetchInput, FetchOutput } from '../types.js';
import { readHandle, type SessionHandle } from '../companion/handle.js';
import { postCompanion } from '../companion/transport.js';
import {
  SESSION_TARGET_ROUTE,
  isSessionTargetRefusal,
  isSessionTargeted,
  type SessionTargetOp,
  type SessionTargetRefusal,
  type SessionTargetRequest,
  type SessionTargetResult,
} from '../companion-contract/session-target.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools');

/**
 * EXTRACT seam 5 — the core side of session-targeted fetch / extract / crawl.
 *
 * A `session_id` on `fetch`, `extract` or `crawl` addresses a LIVE browser session, and the side that owns
 * that browser is the companion, not core. So core's half is a forwarding client: it decides whether a
 * companion is reachable, sends the §4 session-target wire, and returns whatever the companion answered.
 * The composition that drives the session — the control-token gate, the SSRF-fenced navigate, the trusted-0
 * capture — lives with the browser it drives and never ran here after the extraction.
 *
 * Two arms, and the boundary between them is the whole contract:
 *  - PAIRED   → forward verbatim; the companion's success data and its typed refusals both pass through
 *               unchanged, so a refusal reaches the agent in the companion's own words (a pacing-budget or
 *               authenticated-use refusal carries live counters in its sentence; flattening it here would
 *               make a deliberately VISIBLE budget invisible).
 *  - UNPAIRED → an explicit `companion_unavailable` refusal. NEVER a silent downgrade to the ephemeral
 *               path: a caller who asked for their authenticated session and quietly got an anonymous
 *               fetch would believe a page came from a session it never touched.
 *
 * There is deliberately NO auto-launch here, unlike the escalation rung. Escalation asks for "this page,
 * through a real browser" and any fresh browser can answer it. This asks for ONE named session, which a
 * freshly launched companion cannot have — so launching an app would spend a process to arrive at
 * `no_such_session`. A fast typed refusal is the honest answer.
 */

/** The session-target transport: one POST, typed answer or null. Injectable so tests reach no socket. */
export type SessionTargetTransport = (
  handle: SessionHandle,
  request: SessionTargetRequest<unknown>,
) => Promise<SessionTargetResult<unknown> | null>;

export interface SessionTargetDeps {
  dataDir?: string;
  /** Injectable for tests; production uses {@link postSessionTarget}. */
  call?: SessionTargetTransport;
}

export { isSessionTargeted };

/**
 * POST one session-target request to the paired companion and return its typed answer.
 *
 * Returns null — never throws — for every transport-level failure, and for any body that satisfies neither
 * arm of the wire. A well-formed refusal IS returned even on a 4xx: the status is not the gate, because
 * "the companion refused" and "no companion answered" are different facts and the caller's error text
 * depends on telling them apart.
 */
export async function postSessionTarget(
  handle: SessionHandle,
  request: SessionTargetRequest<unknown>,
): Promise<SessionTargetResult<unknown> | null> {
  return postCompanion<SessionTargetResult<unknown>>(handle, {
    route: SESSION_TARGET_ROUTE,
    body: request,
    accept: (parsed, httpOk) => {
      if (isSessionTargetRefusal(parsed)) return parsed;
      if (!httpOk) return null;
      if (typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        return parsed as SessionTargetResult<unknown>;
      }
      return null;
    },
  });
}

/** The unpaired / unreachable refusal. `reason` says which, because the fix differs. */
function unavailable(stage: SessionTargetOp, reason: string, hint: string): SessionTargetRefusal {
  return { ok: false, error: 'companion_unavailable', error_reason: reason, stage, hint };
}

async function forward<TInput extends { session_id?: string }, TData>(
  op: SessionTargetOp,
  input: TInput,
  deps: SessionTargetDeps,
): Promise<SessionTargetResult<TData>> {
  const handle = readHandle(deps.dataDir);
  if (!handle) {
    return unavailable(
      op,
      'No companion is paired, so there is no live session to run this against.',
      'Install and launch the companion app (`wigolo studio setup`), then retry — or omit session_id for an ordinary request.',
    );
  }

  const call = deps.call ?? postSessionTarget;
  const answer = await call(handle, { op, session_id: input.session_id ?? '', input });
  if (answer === null) {
    // The handle is on disk but nothing answered it: the companion died without removing it, or it is
    // wedged. Logged at debug so a stale handle is diagnosable without narrating on every call.
    log.debug('session-target forward failed', { op, endpoint: handle.endpoint });
    return unavailable(
      op,
      'The paired companion did not answer — it may have exited without clearing its handle.',
      'Relaunch the companion app, then retry — or omit session_id for an ordinary request.',
    );
  }
  return answer as SessionTargetResult<TData>;
}

/** Session-targeted fetch: the companion navigates the named session (gated + fenced) and returns the page. */
export async function runSessionFetch(
  input: FetchInput,
  deps: SessionTargetDeps = {},
): Promise<SessionTargetResult<FetchOutput>> {
  return forward<FetchInput, FetchOutput>('fetch', input, deps);
}

/** Session-targeted extract: the companion reads the named session's CURRENT page — no navigation. */
export async function runSessionExtract(
  input: ExtractInput,
  deps: SessionTargetDeps = {},
): Promise<SessionTargetResult<ExtractOutput>> {
  return forward<ExtractInput, ExtractOutput>('extract', input, deps);
}

/** Session-targeted crawl: the companion navigates the seed in the named session (always gated). */
export async function runSessionCrawl(
  input: CrawlInput,
  deps: SessionTargetDeps = {},
): Promise<SessionTargetResult<CrawlOutput>> {
  return forward<CrawlInput, CrawlOutput>('crawl', input, deps);
}
