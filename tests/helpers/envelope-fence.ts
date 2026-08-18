import { isOperationalKey } from '../../src/server/content-fence.js';
import { UNTRUSTED_END_PREFIX, UNTRUSTED_NONCE_HEX_LENGTH } from '../../src/security/untrusted.js';

/**
 * ENVELOPE-WIDE containment walker (A89 §"THE REGRESSION GUARD").
 *
 * The invariant this exists to express, verbatim:
 *
 *   For any tool response, no string reachable in the serialised MCP envelope may contain a byte
 *   sequence derived from fetched content, unless it sits inside a fence region or under an
 *   explicitly allowlisted operational key.
 *
 * Three properties, each of which cost a probe to learn:
 *
 * 1. It asserts at the ENVELOPE over EVERY string field, not on one named field and not per-tool.
 *    The scope originally proposed was "no `error_reason` may carry page bytes" across four tools —
 *    and that guard would have PASSED while `ExtractOutput.warnings` carried page-influenced bytes
 *    out on the SUCCESS envelope, because `fenceExtractData` spreads `...data` and fences only
 *    `data.data`. Walking every reachable string is what makes the next sibling field non-special.
 *
 * 2. The allowlist is `content-fence.ts`'s own `OPERATIONAL_KEYS`, via its own predicate — never a
 *    copy. That set already fails CLOSED for unknown keys, and it is that behaviour, not the current
 *    membership, that the guard locks in: a key added to the production allowlist widens the guard in
 *    lockstep, and there is no second list to drift.
 *
 * 3. Array elements INHERIT the operational-ness of the key that named the array, mirroring
 *    `fenceDeepValue`'s `rawLeaf` carry (`sameAs: [url, url]` stays raw). A walker that reset the key
 *    at the array boundary would report findings production deliberately allows.
 */

export interface UnfencedFinding {
  /** JSON-ish path to the offending string, e.g. `$.content[0].warnings[0]`. */
  path: string;
  /** The key the string sat under — '' for a bare (non-JSON) content block. */
  key: string;
  /** Bytes around the first unfenced occurrence, for a legible failure message. */
  excerpt: string;
}

const NONCE = `[0-9a-f]{${UNTRUSTED_NONCE_HEX_LENGTH}}`;
const OPEN_RE = new RegExp(`\\[\\[BEGIN UNTRUSTED DATA nonce=(${NONCE})(?: origin=[^\\]\\n]*)?\\]\\]`, 'g');

/**
 * The [open, close) spans of regions that are CLOSED BY THEIR OWN NONCE. A page can print the static
 * marker text or a foreign nonce's terminator; neither produces a span here, so pseudo-fenced bytes
 * are still reported as unfenced.
 */
export function closedRegionSpans(s: string): Array<{ open: number; close: number; nonce: string }> {
  const spans: Array<{ open: number; close: number; nonce: string }> = [];
  for (const m of s.matchAll(new RegExp(OPEN_RE))) {
    const close = s.indexOf(`${UNTRUSTED_END_PREFIX}${m[1]}]]`, m.index + m[0].length);
    if (close >= 0) spans.push({ open: m.index, close, nonce: m[1] });
  }
  return spans;
}

/** EVERY occurrence must be contained — a value fenced once and repeated bare is still a leak. */
function unfencedOccurrence(s: string, needle: string): number {
  const spans = closedRegionSpans(s);
  for (let at = s.indexOf(needle); at >= 0; at = s.indexOf(needle, at + 1)) {
    if (!spans.some((sp) => sp.open < at && at < sp.close)) return at;
  }
  return -1;
}

function leafFindings(s: string, needle: string, path: string, key: string): UnfencedFinding[] {
  if (!s.includes(needle)) return [];
  if (isOperationalKey(key)) return []; // the single allowlist, asked in its own words
  const at = unfencedOccurrence(s, needle);
  if (at < 0) return [];
  return [{ path, key, excerpt: s.slice(Math.max(0, at - 40), at + needle.length + 40) }];
}

function walkValue(value: unknown, needle: string, path: string, key: string): UnfencedFinding[] {
  if (typeof value === 'string') return leafFindings(value, needle, path, key);
  if (Array.isArray(value)) {
    // rawLeaf carry: the array inherits its parent key's operational-ness (see property 3 above).
    return value.flatMap((v, i) => walkValue(v, needle, `${path}[${i}]`, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      // An object KEY is a string reachable in the serialised envelope too, and page text does reach
      // one: `fenceTable` rebuilds each row as `{[header]: cell}`, so a page-authored header becomes a
      // KEY. Checking values only made the walker blind to a channel with no length limit at all. The
      // key is checked under the EMPTY key name — a key cannot allowlist itself.
      ...leafFindings(k, needle, `${path}.${k}[key]`, ''),
      ...walkValue(v, needle, `${path}.${k}`, k),
    ]);
  }
  return [];
}

/**
 * Every unfenced occurrence of `needle` reachable in the serialised envelope.
 *
 * A block whose text is JSON is walked structurally so per-key allowlisting applies; a block that is
 * NOT JSON (search emits a bare `[wigolo notice] …` text block) is checked as one leaf under the
 * EMPTY key — which is not operational, so bare blocks fail closed rather than being skipped.
 */
export function findUnfencedInEnvelope(
  blocks: Array<{ type: string; text: string }>,
  needle: string,
): UnfencedFinding[] {
  return blocks.flatMap((b, i) => {
    const path = `$.content[${i}]`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return leafFindings(b.text, needle, `${path}.text`, '');
    }
    return walkValue(parsed, needle, path, '');
  });
}
