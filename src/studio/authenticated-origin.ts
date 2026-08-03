/**
 * S9 / F5 — the AUTHENTICATED-ORIGIN predicate.
 *
 * > An origin is AUTHENTICATED when either holds:
 * >   (a) LEDGER — it reached the login-handoff COMPLETING terminal on this profile; or
 * >   (b) CREDENTIAL-CLASS COOKIE — the profile carries, for a domain covering that origin's host, a
 * >       cookie that is HttpOnly AND Secure AND (session-scoped OR `__Host-`/`__Secure-` prefixed).
 *
 * Evaluated HOST-SIDE only; returns a BOOLEAN. The cookie, its name, and its value never cross into
 * agent-facing output, logs, or the audit table — the same rule handoff.ts applies to storageState reads.
 * That is why the inputs are a projection (`CookieFacts`) with no `value` field at all: the value cannot
 * leak from a payload it was never put into.
 *
 * NO COOKIE-NAME LISTS. `sessionid`/`jwt`/`auth` heuristics are an unwinnable per-site guessing game that
 * rots silently. Every clause here is a structural property the browser itself enforces: `__Host-` cannot
 * be set cross-site and requires Secure + Path=/; HttpOnly means JS cannot read it, which is what a session
 * credential is and what an analytics cookie generally is not; session-scoped means it dies with the
 * browser, which is the shape of a login.
 *
 * ON THE REGISTRABLE-DOMAIN BOUNDARY — this is the one design decision worth reading twice. The spec asks
 * for eTLD+1 matching, which normally means bundling a public-suffix list that goes stale the week it ships.
 * Instead the predicate matches on the cookie's OWN `Domain` attribute, exactly as the browser stored it,
 * because the browser already applied the public suffix list at Set-Cookie time: `a.github.io` physically
 * cannot set `Domain=.github.io`, so its cookie is host-only and cannot reach `b.github.io`, while
 * `login.example.com` CAN set `Domain=.example.com` and legitimately covers `app.example.com`. The boundary
 * is therefore enforced by the same list Chromium ships, kept current by Chromium, with nothing to rot here.
 * This holds only because the sole caller reads its own cookie jar; facts synthesised from an untrusted
 * source would not carry that guarantee.
 *
 * FALSE NEGATIVES ARE SURVIVABLE BY CONSTRUCTION. SPAs holding a bearer token in localStorage have no
 * HttpOnly cookie and will not be flagged. That costs the consent CARD, not the safety RAIL: D9's per-origin
 * budget applies to every origin the agent drives, authenticated or not, and does not consult this
 * predicate. F5 only has to be good enough to keep the card rare and well-targeted.
 */

/** The projection of a browser cookie this predicate reads. Deliberately has NO `value` field. */
export interface CookieFacts {
  /** The cookie's own Domain attribute as the browser stored it ('.example.com' or host-only 'login.example.com'). */
  domain: string;
  /** Needed ONLY for the `__Host-`/`__Secure-` prefix test. Never emitted. */
  name: string;
  httpOnly: boolean;
  secure: boolean;
  /** True when the cookie is session-scoped — no Expires and no Max-Age. */
  session: boolean;
}

export interface AuthenticatedOriginOverrides {
  /** Human-marked authenticated (covers the SPA/bearer false-negative class). */
  authenticated?: ReadonlySet<string>;
  /** Human-marked anonymous (suppresses a persistent false positive). Wins over everything. */
  anonymous?: ReadonlySet<string>;
}

export interface AuthenticatedOriginInputs {
  origin: string;
  cookies: readonly CookieFacts[];
  /** Origins that reached the login-handoff COMPLETING terminal on this profile (clause (a)). */
  ledger: ReadonlySet<string>;
  overrides?: AuthenticatedOriginOverrides;
}

/** Canonical origin form ('https://example.com'), or null when the input is not a usable absolute URL. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * Does a cookie's Domain attribute cover `host`? Host-only exact match, or a leading-dot parent domain —
 * the browser's own host-matching rule. See the module note on why this IS the registrable-domain boundary.
 */
export function cookieDomainCoversHost(cookieDomain: string, host: string): boolean {
  if (!cookieDomain || !host) return false;
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  if (!domain) return false;
  return h === domain || h.endsWith('.' + domain);
}

/** HttpOnly AND Secure AND (session-scoped OR `__Host-`/`__Secure-` prefixed). */
export function isCredentialClassCookie(c: CookieFacts): boolean {
  if (!c.httpOnly || !c.secure) return false;
  return c.session || /^__(Host|Secure)-/.test(c.name);
}

export function isAuthenticatedOrigin(inputs: AuthenticatedOriginInputs): boolean {
  const origin = normalizeOrigin(inputs.origin);
  if (!origin) return false;

  // Human overrides win over the predicate. Anonymous is checked first: it is the escape hatch for a
  // persistent false positive, so it has to beat every other clause including the sticky ledger.
  if (inputs.overrides?.anonymous?.has(origin)) return false;
  if (inputs.overrides?.authenticated?.has(origin)) return true;

  // (a) Ledger — STICKY per profile. Once the human logged in through the handoff (the only login path the
  // agent can trigger), that origin stays authenticated even after its cookies are cleared: the account
  // exists and the agent driving it is still spending the human's identity.
  if (inputs.ledger.has(origin)) return true;

  // (b) Credential-class cookie for a domain covering this origin's host.
  const host = new URL(origin).hostname;
  return inputs.cookies.some((c) => isCredentialClassCookie(c) && cookieDomainCoversHost(c.domain, host));
}
