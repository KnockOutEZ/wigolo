import {
  UNTRUSTED_BEGIN_PREFIX,
  UNTRUSTED_END_PREFIX,
  UNTRUSTED_NONCE_HEX_LENGTH,
} from '../../src/security/untrusted.js';

/**
 * Shared assertions for the P2 nonced untrusted-data fence.
 *
 * Every fence-facing test used to compare against the two STATIC marker strings, or to re-wrap the
 * content in the test and byte-compare. A fresh per-call nonce makes both unsatisfiable, so the
 * equivalent checks are expressed STRUCTURALLY here — once — instead of being weakened in place.
 */

/** The static (nonce-free) forms. Never emitted by the fence; exactly what an attacker would guess. */
export const STATIC_BEGIN = '[[BEGIN UNTRUSTED DATA]]';
export const STATIC_END = '[[END UNTRUSTED DATA]]';

const NONCE = `[0-9a-f]{${UNTRUSTED_NONCE_HEX_LENGTH}}`;

/** Nonces of every opening marker, in order of appearance. */
export function fenceNonces(s: string): string[] {
  const re = new RegExp(`\\[\\[BEGIN UNTRUSTED DATA nonce=(${NONCE})(?: origin=[^\\]\\n]*)?\\]\\]`, 'g');
  return [...s.matchAll(re)].map((m) => m[1]);
}

/**
 * How many opening markers are followed by their OWN closing marker. This is the truncation
 * invariant: an under-reserved budget severs the terminator, and a severed terminator (even one cut
 * mid-nonce, which a prefix count would still credit) drops the region from this total.
 */
export function closedRegions(s: string): number {
  let closed = 0;
  const re = new RegExp(`\\[\\[BEGIN UNTRUSTED DATA nonce=(${NONCE})(?: origin=[^\\]\\n]*)?\\]\\]`, 'g');
  for (const m of s.matchAll(re)) {
    if (s.indexOf(`${UNTRUSTED_END_PREFIX}${m[1]}]]`, m.index + m[0].length) >= 0) closed++;
  }
  return closed;
}

/** Every closing marker that carries a well-formed nonce (valid or not). */
export function closeMarkerCount(s: string): number {
  return [...s.matchAll(new RegExp(`\\[\\[END UNTRUSTED DATA nonce=${NONCE}\\]\\]`, 'g'))].length;
}

/** Blank every nonce so two independently-nonced strings can be compared structurally. */
export function maskNonces(s: string): string {
  return s.replace(new RegExp(NONCE, 'g'), '<NONCE>');
}

/**
 * The [open, close) character span of the region opened by the Nth opening marker. Use it to assert
 * that hostile page text sits STRICTLY INSIDE the fence rather than escaping past its terminator.
 */
export function regionSpan(s: string, index = 0): { open: number; close: number; nonce: string } {
  const re = new RegExp(`\\[\\[BEGIN UNTRUSTED DATA nonce=(${NONCE})(?: origin=[^\\]\\n]*)?\\]\\]`, 'g');
  const matches = [...s.matchAll(re)];
  const m = matches[index];
  if (!m) throw new Error(`no opening marker at index ${index}`);
  const close = s.indexOf(`${UNTRUSTED_END_PREFIX}${m[1]}]]`, m.index + m[0].length);
  if (close < 0) throw new Error(`region ${index} is not closed`);
  return { open: m.index, close, nonce: m[1] };
}

/** The payload between the Nth region's markers, byte-exact. */
export function regionBody(s: string, index = 0): string {
  const { open, close, nonce } = regionSpan(s, index);
  void nonce;
  return s.slice(s.indexOf('\n', open) + 1, close - 1);
}

/** Assertion-friendly: is this string fenced at all? */
export function isFenced(s: string): boolean {
  return s.includes(UNTRUSTED_BEGIN_PREFIX) && closedRegions(s) >= 1;
}

/**
 * The closed region that strictly contains the first occurrence of `needle`, or null when the text
 * is bare / only pseudo-fenced. Stronger than the old "some BEGIN before, some END after" check:
 * the close marker has to be the one matching THAT opener's nonce, so a forged marker planted by
 * the page cannot make a bare payload look contained.
 */
export function enclosingRegion(s: string, needle: string): { open: number; close: number; nonce: string } | null {
  const at = s.indexOf(needle);
  if (at < 0) return null;
  const re = new RegExp(`\\[\\[BEGIN UNTRUSTED DATA nonce=(${NONCE})(?: origin=[^\\]\\n]*)?\\]\\]`, 'g');
  for (const m of s.matchAll(re)) {
    const open = m.index;
    const close = s.indexOf(`${UNTRUSTED_END_PREFIX}${m[1]}]]`, open + m[0].length);
    if (close > at && open < at) return { open, close, nonce: m[1] };
  }
  return null;
}

/** The valid closing marker for a nonce. */
export function closeMarker(nonce: string): string {
  return `${UNTRUSTED_END_PREFIX}${nonce}]]`;
}
