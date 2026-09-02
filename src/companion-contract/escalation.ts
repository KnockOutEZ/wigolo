/**
 * Escalation wire — the challenge-blocked fetch descriptor and its answer.
 *
 * When core's fetch ladder terminates on a bot-protection challenge and a companion is paired, the page
 * is re-fetched through the human's real, attended browser. This module owns the SHAPE of that exchange
 * and nothing else: no transport, no I/O, no imports outside this directory, so it stays extractable to a
 * standalone package.
 *
 * The rung is OPPORTUNISTIC by contract: every failure mode is a typed decline, never a throw and never
 * silence. The core caller falls back to its own honest `blocked_by_challenge` report on any decline, so a
 * companion problem can never turn a clean challenge report into a crash.
 */

/**
 * The capability NAME on the companion transport. Shared by the host seam and the core-side client so the
 * two can never drift into a silent 404 — the drift the studio dispatch name-guards exist for. This is the
 * ONE literal: the host seam re-exports this constant rather than keeping a copy.
 *
 * It is deliberately NOT an MCP tool: it appears in no tool schema, no tool description and no listTools
 * response. Promoting it to a tool would put it in the tool-registration register instead.
 */
export const STUDIO_FETCH_CAPABILITY = 'studio_fetch';

/** One challenge-blocked page, handed to the companion. */
export interface EscalationRequest {
  capability: typeof STUDIO_FETCH_CAPABILITY;
  url: string;
}

/**
 * Every reason the escalation rung can decline, CLOSED.
 *
 * Closed on purpose. The producer seam passes an underlying navigation refusal through verbatim today,
 * which makes its published `error_reason` an open string — fine for a human-read sentence, useless as a
 * wire contract, because a consumer cannot branch on a set it cannot enumerate. `navigation_failed` is the
 * named arm every otherwise-unlisted navigation refusal folds into; its `error` sentence still carries the
 * producer's own words, so nothing legible is lost. `companion_unavailable` and `transport_error` are the
 * client-side declines the bridge synthesises when no companion has published a live handle, or when the
 * call fails or returns a malformed body.
 */
export const ESCALATION_DECLINE_REASONS = Object.freeze([
  'blocked_by_challenge',
  'capture_refused',
  'companion_unavailable',
  'invalid_url',
  'navigation_blocked',
  'navigation_failed',
  'not_holder',
  'studio_no_drive',
  'transport_error',
] as const);

export type EscalationDeclineReason = (typeof ESCALATION_DECLINE_REASONS)[number];

/** The rung served the page: raw HTML, because the caller is the core fetch pipeline, which owns extraction. */
export interface EscalationServed {
  ok: true;
  url: string;
  html: string;
  session_id: string;
}

/**
 * The rung declined. PUBLISHED orientation (not a producer `StageError`): `error_reason` is the stable
 * machine code, `error` the human sentence, `hint` the fix. The session-target wire carries the OPPOSITE
 * orientation, correctly — it reaches the stage-error envelope and this does not. Do not "align" them.
 */
export interface EscalationDecline {
  ok: false;
  error_reason: EscalationDeclineReason;
  error: string;
  hint?: string;
  challenge_class?: string;
}

export type EscalationResponse = EscalationServed | EscalationDecline;

const DECLINE_REASON_SET: ReadonlySet<string> = new Set(ESCALATION_DECLINE_REASONS);

/** True for a well-formed decline arm — the reason must be IN the closed enum, not merely a string. */
export function isEscalationDecline(value: unknown): value is EscalationDecline {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; error_reason?: unknown; error?: unknown };
  return v.ok === false && typeof v.error_reason === 'string' && DECLINE_REASON_SET.has(v.error_reason) && typeof v.error === 'string';
}

/** True for a served arm carrying usable bytes. An empty `html` is a decline in disguise, so it fails here. */
export function isEscalationServed(value: unknown): value is EscalationServed {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; html?: unknown; url?: unknown };
  return v.ok === true && typeof v.html === 'string' && v.html !== '' && typeof v.url === 'string';
}
