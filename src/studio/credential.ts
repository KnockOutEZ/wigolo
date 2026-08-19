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
 * Credential-shaped QUERY-PARAMETER names. A fixed, non-injectable constant for the same reason
 * `CREDENTIAL_URL` is one.
 *
 * `CREDENTIAL_URL` matches login words as PATH segments and is therefore blind to the query string:
 * `/orders?sso_session=…` and `/reset?token=…` both read as ordinary pages. That blindness is harmless
 * wherever the query is dropped before storage, and it is NOT harmless where a URL is kept whole.
 *
 * Names only — never values. A value-matching heuristic would have to look at the secret to decide, and
 * would then be a component that reads secrets in order to avoid storing them.
 */
export const CREDENTIAL_PARAM_NAMES: ReadonlySet<string> = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'passcode', 'pin',
  'session', 'sessionid', 'sid', 'apikey', 'auth', 'authorization', 'otp', 'signature', 'sig',
  'credential', 'credentials', 'jwt', 'bearer',
]);

/**
 * Whether one parameter NAME is credential-shaped.
 *
 * Matched on the whole name with separators removed AND on each separated part, because neither alone
 * is sufficient: `api_key` is only credential-shaped as a whole (`apikey`), while `sso_session` is only
 * credential-shaped in a part (`session`).
 *
 * Deliberately NOT a substring test. `auth` as a substring matches `author`, and refusing to record a
 * step because a page listed articles by author would be the kind of silent over-refusal that makes a
 * guard get switched off.
 */
export function isCredentialParamName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_PARAM_NAMES.has(lower.replace(/[^a-z0-9]+/g, ''))) return true;
  return lower.split(/[^a-z0-9]+/).some((part) => part !== '' && CREDENTIAL_PARAM_NAMES.has(part));
}

/**
 * A fragment read as `k=v` pairs, or empty when it is an ordinary anchor.
 *
 * `#tab=2` and `#access_token=…` are the same syntax, so the shape cannot distinguish them — the NAME
 * does. An anchor with no `=` yields nothing and is left alone.
 */
function fragmentParams(hash: string): URLSearchParams {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  return body.includes('=') ? new URLSearchParams(body) : new URLSearchParams();
}

/**
 * A URL with every credential-shaped parameter REMOVED from its query and fragment, and everything else
 * left byte-intact.
 *
 * **Why redact rather than refuse the step.** Refusing a `navigate` would drop a step out of the middle
 * of a recorded flow while leaving the sequence numbers contiguous — so the recording would look
 * complete and replay the following clicks against whatever page happened to be open. A flow that is
 * silently missing its navigation is a worse object than a token in a local database. Redaction keeps
 * the step, keeps its benign parameters, and stores no secret.
 *
 * A navigation that genuinely REQUIRED the removed parameter will fail at replay — visibly, at the next
 * step's divergence halt, which is the correct place for it to fail.
 *
 * An unparseable URL is returned EMPTY rather than raw: there is no way to redact a string we cannot
 * parse, and returning it unchanged would pass the secret through the function whose job is removing it.
 */
export function redactCredentialParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (isCredentialParamName(name)) parsed.searchParams.delete(name);
  }
  const frag = fragmentParams(parsed.hash);
  if ([...frag.keys()].length > 0) {
    let touched = false;
    for (const name of [...frag.keys()]) {
      if (isCredentialParamName(name)) { frag.delete(name); touched = true; }
    }
    if (touched) {
      const rest = frag.toString();
      parsed.hash = rest === '' ? '' : `#${rest}`;
    }
  }
  return parsed.toString();
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
