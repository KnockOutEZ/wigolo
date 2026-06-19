/**
 * Phase 6c — the DETERMINISTIC risk classifier behind the approval gate.
 *
 * Code, NOT an LLM judge. An LLM classifier would itself read untrusted page content to
 * decide whether an action is risky — putting a prompt-injectable component in charge of
 * the injection defense. The gate is the HARD backstop for an agent that has been jailbroken
 * into following tagged-but-untrusted page content, so it must be robust independent of agent
 * behavior. Hence: pure, deterministic, signal-weighted.
 *
 * WEIGHTING (the load-bearing design): the HARD, host-observed URL is evaluated FIRST and is
 * authoritative — a malicious page cannot rename a risky control to a benign label to dodge
 * the gate, and an absent or forged page-controlled signal can never CLEAR a hard one. The
 * page-controlled element role/name (the spoofable, last-untrusted-injection-surface signal)
 * is consulted only when the URL is silent, and can only RAISE risk, never lower it. This is
 * the classifier-level form of CEO carry-forward (a): page-derived signal is UNTRUSTED data —
 * it may add risk, never subtract it; an absent tag fails safe.
 *
 * Conservative but not paralysing: any matched signal gates, zero signal is safe. Gating every
 * click would make co-browsing unusable (and drown the human in prompts — the "death by prompts"
 * failure the spec warns against), so the default for a no-signal click/type is safe.
 */

/** The four tiers. money / credential / destructive require human approval before firing; safe fires directly. */
export type RiskTier = 'safe' | 'money' | 'credential' | 'destructive';

/** Per-tier match patterns for one haystack (a URL, or an element's role+name). */
export interface TierPatterns {
  credential: RegExp[];
  money: RegExp[];
  destructive: RegExp[];
}

/** The gate policy: how to read the hard URL signal and the soft element signal. Configurable (injected) so the policy is tunable without code change. */
export interface RiskPatterns {
  /** Matched against the host-observed page URL (the HARD signal — not page-controlled). */
  url: TierPatterns;
  /** Matched against the element's `role + name` (the SOFT, page-controlled signal — can raise risk only). */
  element: TierPatterns;
}

/** What the gate hands the classifier. `action` is host-known; `pageUrl` is host-observed; `role`/`name` are page-derived (untrusted). */
export interface RiskSignals {
  action: string;
  /** The current page URL for click/type (host-observed) — the hard signal. */
  pageUrl?: string;
  /** The resolved element's a11y role (page-derived, untrusted — soft signal). */
  role?: string;
  /** The resolved element's accessible name (page-derived, untrusted — soft signal). */
  name?: string;
}

// Path-segment-anchored URL rules (leading `/`) so a risky word in a hostname does not gate every
// page of a site; the path is where the sensitive surface actually lives. Conservative toward gating.
export const DEFAULT_RISK_PATTERNS: RiskPatterns = {
  url: {
    credential: [/\/(login|log-in|signin|sign-in|sign_in|auth|oauth|sso|mfa|2fa|otp|verify|password|session\/new|account\/security)\b/i],
    money: [/\/(checkout|payment|payments|pay|billing|purchase|subscribe|donate|transfer|withdraw|wire|send-money|order\/(confirm|place))\b/i],
    destructive: [/\/(delete|remove|deactivate|destroy|close-account|cancel-(subscription|account)|admin\/delete)\b/i],
  },
  element: {
    credential: [/\b(password|passcode|cvv|cvc|ssn|social security|card number|one[-\s]?time (code|password)|verification code)\b/i],
    money: [/\b(pay|buy|checkout|place order|purchase|complete (order|purchase)|donate|subscribe|transfer|send money)\b/i, /\$\s?\d/],
    destructive: [/\b(delete|remove|deactivate|permanently|erase|destroy|close account|cancel (subscription|account))\b/i],
  },
};

/** First matching tier for a haystack, credential→money→destructive (credential is the most sensitive, so it wins ties). null = no match. */
function matchTier(haystack: string, tp: TierPatterns): RiskTier | null {
  if (tp.credential.some((re) => re.test(haystack))) return 'credential';
  if (tp.money.some((re) => re.test(haystack))) return 'money';
  if (tp.destructive.some((re) => re.test(haystack))) return 'destructive';
  return null;
}

/**
 * Classify the risk of an agent action. Only click/type are gateable; everything else is safe.
 * Hard URL signal first (authoritative); the soft element signal only when the URL is silent.
 */
export function classifyRisk(signals: RiskSignals, patterns: RiskPatterns = DEFAULT_RISK_PATTERNS): RiskTier {
  if (signals.action !== 'click' && signals.action !== 'type') return 'safe';

  // HARD signal — the host-observed URL cannot be renamed by the page; it is authoritative.
  if (signals.pageUrl) {
    const urlTier = matchTier(signals.pageUrl, patterns.url);
    if (urlTier) return urlTier;
  }

  // SOFT signal — page-controlled role/name. Reached only when the URL is silent; can RAISE
  // risk (gate), never lower it (a benign name on a risky URL was already gated above).
  const elTier = matchTier(`${signals.role ?? ''} ${signals.name ?? ''}`, patterns.element);
  if (elTier) return elTier;

  return 'safe';
}
