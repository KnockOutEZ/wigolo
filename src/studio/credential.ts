/**
 * Slice 5a — the HARD, deterministic credential-input guard.
 *
 * The agent NEVER types into a credential field (HANDOFF §2/§4: login is human-only). This is a
 * fail-closed REFUSAL, distinct from the approval-gateable risk tier in `risk.ts`: a credential
 * field is not "ask the human to approve", it is "the agent does not do this at all".
 *
 * It decides on the element's TRUE input semantics — `input[type=password]` or a credential
 * `autocomplete` token, read from the PRIVILEGED pierced DOM — and DELIBERATELY ignores the a11y
 * role/name, which a page controls and can blank or forge (see `risk.ts` weighting note). A password
 * field with an empty or misleading label is still caught.
 *
 * Self-contained on purpose: the URL pattern here is a fixed constant, NOT the injectable risk
 * patterns, so a hard credential backstop cannot be weakened by re-tuning the (heuristic) risk
 * policy. The credential-CONTEXT predicate (`isCredentialContext`) is reused by Slice 5b (capture
 * exclusion) — both surfaces share ONE notion of "we are handling credentials here".
 */

export interface FieldSemantics {
  /** localName from the privileged pierced DOM (e.g. `input`, `textarea`, `iframe`, a custom-element tag). */
  tag?: string;
  /** The `type` attribute for inputs (e.g. `password`, `text`). */
  type?: string;
  /** The `autocomplete` attribute (e.g. `current-password`, `one-time-code`). */
  autocomplete?: string;
  /**
   * The accessible name (page-derived, UNTRUSTED). The credential predicate MUST NOT decide on this
   * — a page can blank or forge it. Carried only so the host has the full descriptor; `isCredentialField`
   * ignores it by design. (Swapping the type/autocomplete read for this is the anti-vacuity mutation the
   * 5a tests pin: it must flip the password vector from refused to typed.)
   */
  name?: string;
}

/** `autocomplete` tokens that denote a secret the human must enter. */
export const CREDENTIAL_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'current-password',
  'new-password',
  'one-time-code',
]);

/**
 * TRUE-semantics credential test: an `input[type=password]`, OR any element carrying a credential
 * `autocomplete` token. Role/name are intentionally NOT consulted (spoofable).
 */
export function isCredentialField(f: FieldSemantics): boolean {
  const tag = (f.tag ?? '').toLowerCase();
  const type = (f.type ?? '').toLowerCase();
  const autocomplete = (f.autocomplete ?? '').toLowerCase().trim();
  if (tag === 'input' && type === 'password') return true;
  if (CREDENTIAL_AUTOCOMPLETE.has(autocomplete)) return true;
  return false;
}

/** Standard, analyzable form controls. When one of these is NOT a credential field, the agent may type into it. */
const ANALYZABLE_CONTROL_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);

/**
 * Whether the target's true semantics are READABLE — a standard control we can trust as non-credential
 * when `isCredentialField` is false. A custom element / iframe owner / contenteditable is NOT
 * analyzable: its true semantics are unknown, so in a credential context it must fail closed.
 */
export function isAnalyzableControl(f: FieldSemantics | null | undefined): boolean {
  return !!f && ANALYZABLE_CONTROL_TAGS.has((f.tag ?? '').toLowerCase());
}

/**
 * Credential-context URL test. Mirrors the credential URL INTENT in `risk.ts` but is a fixed,
 * non-injectable constant here — the hard guard must not be weakenable by re-tuning risk policy.
 */
export const CREDENTIAL_URL =
  /\/(login|log-in|signin|sign-in|sign_in|auth|oauth|sso|mfa|2fa|otp|verify|password|session\/new|account\/security)\b/i;

export function isCredentialUrl(url: string | undefined): boolean {
  return typeof url === 'string' && CREDENTIAL_URL.test(url);
}

/**
 * The factored credential-CONTEXT predicate (Slice 5b reuses this): a login URL OR any credential
 * field present on the page. "Field present" uses the same true-semantics test, so the context view
 * here and a snapshot's precomputed `hasCredentialField` agree by construction.
 */
export function isCredentialContext(input: { pageUrl?: string; fields?: Iterable<FieldSemantics> }): boolean {
  if (isCredentialUrl(input.pageUrl)) return true;
  for (const f of input.fields ?? []) {
    if (isCredentialField(f)) return true;
  }
  return false;
}

/**
 * The hard refusal decision for an agent `type`:
 *  - rule 1: the target IS a credential field → REFUSE regardless of URL (the off-login case).
 *  - rule 2: the target's true semantics are unreadable/ambiguous AND we are in a credential context
 *    (login URL or a credential field present) → REFUSE (fail-closed — custom element / iframe).
 *  - otherwise → allow (an analyzable non-credential control; no over-refusal).
 *
 * `pageHasCredentialField` is the snapshot's precomputed page scan (same `isCredentialField` test),
 * so rule 2's context matches `isCredentialContext` without re-scanning here.
 */
export function refuseAgentType(input: {
  target: FieldSemantics | null | undefined;
  pageUrl?: string;
  pageHasCredentialField?: boolean;
}): boolean {
  if (input.target && isCredentialField(input.target)) return true; // rule 1
  if (!isAnalyzableControl(input.target)) {
    if (isCredentialUrl(input.pageUrl) || input.pageHasCredentialField === true) return true; // rule 2 (fail-closed)
  }
  return false; // rule 3
}
