/**
 * Origin plumbing shared by the companion layer and the studio domain layer.
 *
 * The SPLIT half of what was `studio/authenticated-origin.ts` (spec §2.2 — the one table entry
 * that is a split rather than a move). `normalizeOrigin` is a canonicalizer over `URL` with no
 * credential knowledge in it, and `AuthenticatedOriginOverrides` is the SHAPE of the human's
 * per-origin override store — the store itself (`auth-origin-store.ts`) is companion plumbing
 * that `wigolo config --authenticated-origin` writes, so it cannot reach across into the
 * credential module for its own record type.
 *
 * The PREDICATE stays behind: credential-class cookie analysis is the F5 consent trigger, which
 * is domain logic and leaves with the credential arc.
 */

/**
 * Canonical origin form ('https://example.com'), or null when the input is not a usable absolute
 * URL. `null` is also the answer for an opaque origin (a `data:` or `blob:` URL, whose `origin`
 * is the literal string 'null') — a caller keying a store by origin must never key it by a value
 * that every opaque origin shares.
 */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/** The human's per-origin overrides of the authenticated-origin verdict. */
export interface AuthenticatedOriginOverrides {
  /** Human-marked authenticated (covers the SPA/bearer false-negative class). */
  authenticated?: ReadonlySet<string>;
  /** Human-marked anonymous (suppresses a persistent false positive). Wins over everything. */
  anonymous?: ReadonlySet<string>;
}
