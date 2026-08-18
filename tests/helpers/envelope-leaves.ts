import { closedRegionSpans } from './envelope-fence.js';
import { UNTRUSTED_END_PREFIX, UNTRUSTED_NONCE_HEX_LENGTH, UNTRUSTED_PREAMBLE } from '../../src/security/untrusted.js';

/**
 * ── THE NEVER-FENCED WALKER ─────────────────────────────────────────────────────────────────────
 *
 * `envelope-fence.ts` answers "did THIS byte sequence escape a fence?". It is a NEEDLE walker: a
 * field only comes under scrutiny once a fixture author has planted the canary in it. Nine separate
 * unfenced-string defects were found by hand in one day precisely because nobody planted a canary in
 * the tenth field — `fenceTable`'s row keys, fetch's 200-byte body snippet, `crawlCacheFailure`,
 * `fenceCrawlData`'s map-branch `error`, `fenceCacheData`'s `!Array.isArray` early return,
 * `SearchOutput.error`, cache.ts's success-envelope prose, `links[].to`, two firecrawl-compat routes.
 *
 * Every one of them shipped because someone ASSUMED a string's shape — "it's a code", "it's a URL",
 * "it's a line count" — and nothing enforced the assumption. The author of the last one named the
 * root cause exactly: "I treated 'it is typed as a URL' as 'it contains a URL'. The type says nothing
 * about what the extractor puts there." A TYPE NAME IS NOT A VALIDATION, so the guard must be
 * runtime and structural.
 *
 * This module therefore inverts the question. It takes no needle. It walks the ACTUAL EMITTED OBJECT
 * and reports EVERY string leaf that is not a whole, nonce-matched fence region. A newly-added raw
 * field is reported the moment it reaches an envelope, whether or not anyone thought to plant
 * anything in it — which is the property that makes an unfenced field fail BY DEFAULT rather than
 * waiting for a reviewer to notice.
 *
 * THREE PROPERTIES, each of which the nine defects paid for:
 *
 * 1. KEYS ARE LEAVES TOO. `fenceTable` used to rebuild each row as `{[header]: cell}`, so page prose
 *    occupied a KEY position with no length bound at all — and the values-only walker of the day was
 *    blind to it. Object keys are walked here as first-class leaves.
 *
 * 2. CONTAINMENT IS WHOLE-STRING AND NONCE-MATCHED. `isFenced`-style "contains a BEGIN marker" is
 *    satisfied by a leaf that is half fence and half bare prose — exactly the shape a producer that
 *    interpolates a fenced excerpt into a sentence emits. A leaf counts as contained only when the
 *    ENTIRE string is one region whose terminator carries its own opener's nonce.
 *
 * 3. A NONCE THE PRODUCER COULD HAVE CHOSEN IS NOT A NONCE. Anchoring alone would credit a page that
 *    returns a syntactically perfect forged block as its whole payload. Callers pass the nonces that
 *    appear in their own FIXTURE INPUT; a region carrying one of those is reported as `forged`, not
 *    as containment. That is strictly stronger than the existing helper, never looser.
 */

const NONCE = `[0-9a-f]{${UNTRUSTED_NONCE_HEX_LENGTH}}`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A COMPLETE fence block, anchored to the whole string, with the terminator bound to its own
 * opener's nonce by backreference. This is the exact shape `composeFence` emits and nothing else.
 */
const WHOLE_FENCE_RE = new RegExp(
  `^${escapeRe(UNTRUSTED_PREAMBLE)}\\n` +
    `\\[\\[BEGIN UNTRUSTED DATA nonce=(${NONCE})(?: origin=[^\\]\\n]*)?\\]\\]\\n` +
    `[\\s\\S]*\\n` +
    `${escapeRe(UNTRUSTED_END_PREFIX)}\\1\\]\\]$`,
);

export type FenceVerdict = 'contained' | 'raw' | 'forged' | 'partial';

/**
 * How contained a single string leaf is.
 *
 *  - `contained` — the whole leaf is one region closed by its own nonce, and that nonce was not
 *    available to the producer.
 *  - `forged`    — the leaf LOOKS like a whole region but carries a nonce the caller supplied as
 *    input, so the "fence" is page-authored. Reported, never credited.
 *  - `partial`   — the leaf carries at least one closed region but is not wholly one. A producer
 *    that splices a fenced excerpt into its own sentence lands here, and so does a severed
 *    terminator. Reported: bytes outside the region are in instruction position.
 *  - `raw`       — no closed region at all.
 */
export function fenceVerdict(s: string, producerNonces: ReadonlySet<string> = new Set()): FenceVerdict {
  const whole = WHOLE_FENCE_RE.exec(s);
  if (whole) return producerNonces.has(whole[1]) ? 'forged' : 'contained';
  return closedRegionSpans(s).length > 0 ? 'partial' : 'raw';
}

export interface StringLeaf {
  /** JSON-ish path, e.g. `$.results[].title`. Array indices are collapsed to `[]`. */
  path: string;
  /** `value` for a string value; `key` for an object key, which is a string on the wire too. */
  position: 'value' | 'key';
  /** The key the string sat under. Empty for a bare (non-JSON) block or a key leaf. */
  key: string;
  value: string;
  verdict: FenceVerdict;
}

function walk(
  node: unknown,
  path: string,
  key: string,
  producerNonces: ReadonlySet<string>,
  out: StringLeaf[],
  depth: number,
): void {
  // Deeper than any fencer descends (MAX_FENCE_DEPTH is 16); a bound here only stops a cyclic
  // fixture, and every string leaf above it has already been recorded.
  if (depth > 24) return;
  if (typeof node === 'string') {
    out.push({ path, position: 'value', key, value: node, verdict: fenceVerdict(node, producerNonces) });
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walk(v, `${path}[]`, key, producerNonces, out, depth + 1);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // A KEY is a string reachable in the serialised envelope. It gets a path that does NOT embed
      // its own text — a key cannot name itself out of scrutiny, and a page-chosen key would
      // otherwise mint a fresh, unallowlisted path on every call.
      out.push({ path: `${path}{key}`, position: 'key', key: '', value: k, verdict: fenceVerdict(k, producerNonces) });
      walk(v, `${path}.${k}`, k, producerNonces, out, depth + 1);
    }
  }
}

/** Every string leaf reachable in `root`, keys included, each with its containment verdict. */
export function stringLeaves(root: unknown, producerNonces: ReadonlySet<string> = new Set()): StringLeaf[] {
  const out: StringLeaf[] = [];
  walk(root, '$', '', producerNonces, out, 0);
  return out;
}

/**
 * Leaves of an MCP `content[]` array. A block whose text parses as JSON is walked structurally; a
 * block that does not (search emits a bare `[wigolo notice] …` text block) is ONE leaf under the
 * empty key, so bare blocks fail closed rather than being skipped.
 */
export function envelopeLeaves(
  blocks: Array<{ type: string; text: string }>,
  producerNonces: ReadonlySet<string> = new Set(),
): StringLeaf[] {
  return blocks.flatMap((b) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return [
        { path: '$<bare block>', position: 'value' as const, key: '', value: b.text, verdict: fenceVerdict(b.text, producerNonces) },
      ];
    }
    return stringLeaves(parsed, producerNonces);
  });
}
