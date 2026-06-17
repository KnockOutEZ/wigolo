/**
 * Pure, stateless derivation of a stable cross-turn element ref from the live
 * (accessibility ⋈ DOM) state. NO counter, NO per-session registry — a ref is a
 * pure function of the element's fingerprint (+ a positional disambiguator only when
 * the fingerprint collides in the snapshot). So a COLD service (after a daemon
 * restart, a client reconnect, or across the stdio↔host proxy boundary) produces
 * identical handles to a warm one. This is the exact algorithm the 2D spike
 * measured; the normalization here is fixed and pinned by the ported regression
 * fixtures (tests/fixtures/studio/*) — do not tweak it without re-pinning them.
 */

const STABLE_ATTRS = ['type', 'name', 'placeholder'] as const;

/** Deterministic 32-bit FNV-1a, rendered base36 — a compact opaque ref body. Exported so the snapshot id + churn-group share one stable hash. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface FingerprintInput {
  role: string;
  name: string;
  /** Attributes sourced via the PRIVILEGED CDP path (DOM.getDocument pierce) so closed-shadow nodes are not degraded. */
  attrs?: Record<string, string>;
}

/** Fixed normalization: case-folded role, trimmed + whitespace-collapsed name, a small fixed-order stable-attr subset. */
export function computeFingerprint(input: FingerprintInput): string {
  const role = (input.role ?? '').trim().toLowerCase();
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  const attrs = input.attrs ?? {};
  // STABLE_ATTRS is a FIXED order, so the result is independent of the caller's key order,
  // and excludes volatile attrs (id/class/style) that would drift across a re-render.
  const attrPart = STABLE_ATTRS.filter((k) => attrs[k] != null && attrs[k] !== '')
    .map((k) => `${k}=${attrs[k]}`)
    .join(';');
  return `${role}\x00${name}\x00${attrPart}`;
}

export interface RefInput {
  fingerprint: string;
  positionPath: string;
}

export interface RefOutput {
  ref: string;
  /** Set when this ref was positionally tiebroken (≥2 identical-fingerprint siblings) — unstable under reorder. */
  confidence?: 'low';
}

/**
 * Assign a ref per node, in input order. A UNIQUE fingerprint → `hash(fingerprint)`
 * (position-free, so it survives reorder). A COLLIDING fingerprint (≥2 in this
 * snapshot) → `hash(fingerprint|positionPath)` AND `confidence:'low'` set NOW — the
 * single-snapshot signal 2J consumes: identical-sibling refs are positionally
 * tiebroken and so unstable under reorder, and must not be silently
 * resolved-by-ID-and-actioned (re-observe/ask instead).
 */
export function assignRefs(nodes: RefInput[]): RefOutput[] {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.fingerprint, (counts.get(n.fingerprint) ?? 0) + 1);
  return nodes.map((n) =>
    (counts.get(n.fingerprint) ?? 0) > 1
      ? { ref: 'e' + hash(n.fingerprint + '|' + n.positionPath), confidence: 'low' }
      : { ref: 'e' + hash(n.fingerprint) },
  );
}
