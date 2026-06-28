import type { RiskTier } from './risk.js';

/**
 * S7 — the pre-grant authorization scope store.
 *
 * A pre-grant lets the human AUTHORIZE-IN-ADVANCE a class of risky agent actions ("clicking money-risk
 * buttons on shop.example is OK this session") so the agent does not have to stop for a live verdict on each
 * one. It is a set of {domain, actionType, riskTier} entries, per-session, revocable, EMPTY by default.
 *
 * TRUST BRIGHT-LINE: this store is CLOSURE-LOCAL in the host (mirroring NavGrant) and OFF the session object —
 * the agent holds no reference to it and there is NO agent/MCP path that writes it. The ONLY writer is the
 * host's {t:'grant'} WS handler (the human channel, bearer-authed, party host-stamped 'human'). An agent-spawned
 * background session therefore starts (and stays) with an EMPTY store until a human grants — so a risky action
 * with no matching grant PARKS for human review, never auto-authorizes.
 *
 * Matching is read PULL-AT-EVAL at the act gate (like NavGrant), so a grant/revoke takes effect on the next
 * action with no re-arm window. Fail-closed: an unparseable domain or any missing field ⇒ no match ⇒ park.
 */
export interface PreGrantEntry {
  /** The page origin hostname the grant applies to (e.g. 'shop.example'). Matched against new URL(currentUrl).hostname. */
  domain: string;
  /** The action class the grant covers ('click' | 'type'). navigate is never pre-granted (it skips the gate, SSRF-fenced). */
  actionType: string;
  /** The risk tier the grant covers (money / credential / destructive). */
  riskTier: RiskTier;
}

export class PreGrantStore {
  private entries: PreGrantEntry[] = [];

  /** The number of live grant entries (0 by default — the fail-closed baseline). */
  get size(): number {
    return this.entries.length;
  }

  /** Add a grant entry (idempotent — an identical entry is not duplicated). HOST-ONLY caller: the {t:'grant'} WS handler. */
  add(entry: PreGrantEntry): void {
    if (this.entries.some((e) => e.domain === entry.domain && e.actionType === entry.actionType && e.riskTier === entry.riskTier)) return;
    this.entries.push({ ...entry });
  }

  /** Revoke a specific grant (human-driven). */
  revoke(entry: PreGrantEntry): void {
    this.entries = this.entries.filter((e) => !(e.domain === entry.domain && e.actionType === entry.actionType && e.riskTier === entry.riskTier));
  }

  /** Revoke all grants this session. */
  clear(): void {
    this.entries = [];
  }

  /**
   * Does a risky action match a live grant? Domain AND actionType AND riskTier must all match. Fail-closed:
   * an undefined domain (currentUrl unreadable) never matches. Read pull-at-eval at the gate.
   */
  matches(query: { domain: string | undefined; actionType: string; riskTier: RiskTier }): boolean {
    if (!query.domain) return false;
    return this.entries.some(
      (e) => e.domain === query.domain && e.actionType === query.actionType && e.riskTier === query.riskTier,
    );
  }

  /** Enumeration-safe snapshot (for surfacing the active scope to the human). */
  snapshot(): PreGrantEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}

/** Derive the page-origin hostname from the live URL; undefined (→ fail-closed no-match) if it cannot be parsed. */
export function deriveDomain(currentUrl: string | undefined): string | undefined {
  if (!currentUrl) return undefined;
  try {
    return new URL(currentUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}
