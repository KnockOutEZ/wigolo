/**
 * Session-target wire — session-scoped fetch / extract / crawl against a live companion session.
 *
 * These run ON THE HOST, against a live session's drive seam. The stdio side never executes them: there
 * the session accessor is absent and the call is forwarded verbatim. An absent companion is an explicit
 * typed refusal, NEVER a silent downgrade to the ephemeral path — that is the whole contract.
 *
 * NAV-CLASS contract, restated here because the wire's consumers depend on it:
 *  - `fetch`   ALWAYS navigates (gated + fenced) → reads the resulting page → persists untrusted.
 *  - `extract` reads the session's CURRENT page — the SOLE token-free read; it does NOT navigate.
 *  - `crawl`   ALWAYS navigates → always gated.
 * None of the three click or type, so the pre-grant interaction gate is never involved.
 *
 * Payloads are GENERIC on purpose. The request input and the success data are core's own stage shapes, and
 * this directory may not import them (no imports outside the contract, so it stays extractable). Copying
 * `FetchOutput` here would create exactly the drift a contract exists to prevent, so the wire owns what is
 * genuinely wire-shaped — the op set, the refusal arms and the routing predicate — and carries the payload
 * as a type parameter each side supplies from its own stage types.
 */

/** The three navigation-class ops, CLOSED. */
export const SESSION_TARGET_OPS = Object.freeze(['crawl', 'extract', 'fetch'] as const);

export type SessionTargetOp = (typeof SESSION_TARGET_OPS)[number];

/** One session-scoped call. `session_id` addresses a LIVE session; a dead one is `no_such_session`. */
export interface SessionTargetRequest<TInput> {
  op: SessionTargetOp;
  session_id: string;
  input: TInput;
}

/**
 * Every reason a session-targeted op can refuse, CLOSED.
 *
 * `navigation_failed` is the named arm that absorbs a navigation refusal with no listed code of its own —
 * the pacing-budget and authenticated-use refusals arrive with their own sentence and hint, and those are
 * passed through in `error_reason` / `hint` rather than flattened, because a visible budget that reports
 * itself as a generic nav failure is not visible. `companion_unavailable` is the unpaired refusal.
 */
export const SESSION_TARGET_REFUSAL_REASONS = Object.freeze([
  'aborted_reclaimed',
  'capture_refused',
  'companion_unavailable',
  'navigation_blocked',
  'navigation_failed',
  'no_such_session',
  'not_holder',
] as const);

export type SessionTargetRefusalReason = (typeof SESSION_TARGET_REFUSAL_REASONS)[number];

/**
 * The refusal arm, in the PRODUCER orientation the composition already publishes: `error` is the stable
 * machine code and `error_reason` the human sentence. That is the reverse of the escalation wire's
 * orientation, and deliberately so — these results reach the stage-error envelope, which performs the
 * swap downstream, and the escalation envelope is published verbatim.
 */
export interface SessionTargetRefusal {
  ok: false;
  error: SessionTargetRefusalReason;
  error_reason: string;
  stage: SessionTargetOp;
  hint?: string;
}

export type SessionTargetResult<TData> = { ok: true; data: TData } | SessionTargetRefusal;

const REFUSAL_REASON_SET: ReadonlySet<string> = new Set(SESSION_TARGET_REFUSAL_REASONS);

/** True for a well-formed refusal arm — the code must be IN the closed enum. */
export function isSessionTargetRefusal(value: unknown): value is SessionTargetRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; error?: unknown };
  return v.ok === false && typeof v.error === 'string' && REFUSAL_REASON_SET.has(v.error);
}

/**
 * True when the input carries a non-empty `session_id` ⇒ route to the session path, not the ephemeral one.
 * Whitespace does not count: a blank id would otherwise route to a session lookup that can only miss.
 */
export function isSessionTargeted(input: { session_id?: unknown }): boolean {
  return typeof input.session_id === 'string' && input.session_id.trim() !== '';
}
