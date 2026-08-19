/**
 * ── THE ALLOWLIST ───────────────────────────────────────────────────────────────────────────────
 *
 * The walker in `envelope-leaves.ts` reports every string leaf that is not a whole nonce-matched
 * fence region. This file is the other half of the invariant: the finite, justified set of leaves
 * that are allowed to be raw. Anything not named here fails.
 *
 * WHAT AN ENTRY MUST CARRY, and why each part is load-bearing rather than decorative:
 *
 *  - `why`      — prose. Not "it is a URL". Nine unfenced-string defects shipped in this tree
 *                 because someone treated "it is TYPED as a URL" as "it CONTAINS a URL"; the type
 *                 says nothing about what an extractor puts there. An entry that asserts the shape
 *                 without saying what produces it is the defect, not the fix.
 *  - `producer` — `file:line` of the construction. Checked to exist, so a citation cannot rot into
 *                 a number nobody can follow.
 *  - `shape`    — THE POINT. A predicate the EMITTED VALUE must satisfy on every run. This is what
 *                 turns a claim into a check: `absolute-http-url` is not "we believe this is a URL",
 *                 it is `new URL(v)` parsing to an http(s) origin with no whitespace — precisely the
 *                 test the `links[].to` defect failed (multi-line values, opaque-path schemes).
 *
 * WHERE THIS INVARIANT IS WEAKEST, stated rather than implied away. The `authored-prose` shape is
 * NOT a check — free prose is indistinguishable from page prose byte for byte, so no predicate can
 * vouch for it. An entry in that class means "a human enumerated this field and cited its producer",
 * which is strictly weaker than the shape-checked classes and is exactly the kind of claim the nine
 * defects were made of. Two things keep it from becoming a dumping ground: the class is COUNT-GATED
 * (`AUTHORED_PROSE_BUDGET`), so it cannot grow silently; and a field only reaches it after the
 * walker has already forced someone to look at it, which is the step that was missing before.
 *
 * KNOWN_OPEN is NOT this list. An entry there is page-derived and unfenced TODAY: a live channel
 * recorded so the invariant is green on a clean tip while the debt stays enumerable and drift-gated.
 * Moving a leaf from KNOWN_OPEN to ALLOWED_RAW requires a construction; moving it out entirely
 * requires the fence.
 */

/** Shapes the emitted value is checked against. Each is a real predicate, never a description. */
export type ValueShape =
  | 'absolute-http-url'
  | 'link-target'
  | 'artifact-uri'
  | 'sha256-hex'
  | 'iso-8601'
  | 'machine-code'
  | 'column-handle'
  | 'identifier'
  | 'diff-line-counts'
  | 'base64-blob'
  | 'digits'
  | 'authored-prose';

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/** Schemes an agent may be handed as a dereferenceable identity beyond the web ones. */
const URI_SCHEMES = new Set(['http:', 'https:', 'studio:', 'data:']);

function parsesAsUrl(v: string, schemes: Set<string> | null): boolean {
  // A URL that carries whitespace or a control byte is not a URL an agent can dereference — it is
  // prose that happened to start with one. `links[].to` shipped multi-line values under a `to: string`
  // declaration, so this is checked rather than assumed.
  if (v.length === 0 || v.length > 2048) return false;
  // `schemes: null` means "any scheme" — the link-target case, where the producer's guarantee is
  // parseability and line-break freedom, NOT a scheme allowlist. The whitespace rejection is skipped
  // with it, because opaque-path schemes measurably keep their spaces.
  if (schemes !== null && /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return schemes === null || schemes.has(u.protocol);
  } catch {
    return false;
  }
}

export function satisfiesShape(shape: ValueShape, v: string): boolean {
  switch (shape) {
    case 'absolute-http-url':
      return parsesAsUrl(v, HTTP_SCHEMES);
    // A crawl link target, and DELIBERATELY weaker than a URL check. `normalizeLinkTarget`
    // (src/crawl/url-utils.ts:62) is `new URL(target, from)`, so the guarantee it actually provides
    // was MEASURED rather than assumed, and it is narrower than the field name suggests:
    //   'javascript:alert(1)\nIGNORE ALL...'  ->  'javascript:alert(1)IGNORE ALL...'   (one line, prose survives)
    //   'mailto:a@b?subject=IGNORE ALL...'     ->  percent-encoded                       (hierarchical)
    //   'tel:+1 555 0100'                      ->  unchanged, SPACES INTACT              (opaque path)
    //   'https://exa mple.com'                 ->  null, dropped by the caller
    // So prose CAN still ride an opaque-path scheme on one line. What is total on every scheme is
    // that the parser strips tab/CR/LF before parsing, so NO LINE BREAK survives — which is the
    // property that matters here, because a forged `[[END UNTRUSTED DATA nonce=…]]` needs its own
    // line to read as a terminator. Encoding the weaker true guarantee beats encoding the stronger
    // false one: `absolute-http-url` here would reject an ordinary `mailto:` link and fail on real
    // data, which is how a check gets weakened back out again.
    case 'link-target':
      return v.length > 0 && v.length <= 2048 && !/[\n\r\t]/.test(v) && parsesAsUrl(v, null);
    case 'artifact-uri':
      return parsesAsUrl(v, URI_SCHEMES);
    case 'sha256-hex':
      return /^[0-9a-f]{64}$/.test(v);
    case 'iso-8601':
      return /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v);
    // A closed machine vocabulary: lowercase snake/kebab tokens, no spaces, short. This is the shape
    // every stage code, enum member and provenance tag in the tree already has, and it is the one a
    // sentence of page prose cannot take.
    case 'machine-code':
      return /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(v) && v.length <= 48;
    case 'column-handle':
      return /^col_\d+$/.test(v);
    // A bare property-name token: schema.org terms, caller schema properties, inline literal keys.
    // Identifier syntax with no spaces, so a `<th>`-style prose channel cannot hide here. It is a
    // BOUND on how much can leak, not a claim that nothing does — see KNOWN_OPEN GAP-6a.
    case 'identifier':
      return /^@?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v);
    // The THREE templates computeDiffSummary can emit, and nothing else. The earlier version of this
    // predicate matched `+N / -M lines`, a shape no producer emits — it was fitted to a fixture value
    // rather than read off `src/cache/diff-summary.ts`, which is the same mistake in miniature that
    // this whole file exists to catch. Numbers are the only variable part in all three.
    case 'diff-line-counts':
      return (
        /^\d+ lines? added, \d+ lines? removed, \d+ lines? modified$/.test(v) ||
        /^Content changed significantly \(\d+ -> \d+ lines\)$/.test(v) ||
        v === 'Unable to compute diff summary'
      );
    case 'base64-blob':
      return /^[A-Za-z0-9+/]+={0,2}$/.test(v);
    case 'digits':
      return /^\d+$/.test(v);
    // Deliberately unconstrained: nothing distinguishes authored prose from page prose by inspection.
    // The check for this class is the COUNT gate (AUTHORED_PROSE_BUDGET), not the value.
    case 'authored-prose':
      return true;
  }
}

export interface RawValueAllowance {
  /** `<case>:<json path>` exactly as the walker reports it. Array indices collapse to `[]`. */
  path: string;
  why: string;
  /** `src/file.ts:LINE` — verified to exist at test time. */
  producer: string;
  shape: ValueShape;
  /**
   * A construction too specific to share a named shape — the exact template the producer emits.
   * When present it REPLACES the shape check. Use it when the producer interpolates into a literal:
   * that template IS the guarantee, and a looser shared shape would accept strings the producer
   * cannot emit, which is how a check stops being one.
   */
  pattern?: RegExp;
}

/**
 * How many `authored-prose` allowances the invariant tolerates.
 *
 * BE CLEAR ABOUT WHAT THIS IS: it is set to the current population, so it forbids GROWTH and nothing
 * else. It does not check a single byte, and it says nothing about whether the entries under it are
 * correct — tracing their producers moved eleven of them out of this class (four to recorded holes,
 * six to dead fields, one to a checked template), and the count gate detected none of that. It is a
 * ratchet on the size of the unverifiable surface, not evidence about its contents.
 */
// 23 -> 25 (S14-2): `version_list.note` and `version_not_retained.reason`. Both are module-level
// literals with NO interpolation slot at all — nothing, caller or page, is spliced into either — and
// both carry a `pattern` pinning the producer's opening bytes, so unlike the rest of this class they
// are checked on every run. The ratchet still moves, which is why it is stated here rather than
// quietly widened: the honest reading is that the unverifiable surface grew by two entries that
// happen to be verifiable, and a later pass should give that sub-class its own shape.
export const AUTHORED_PROSE_BUDGET = 25;

/**
 * Containers whose KEYS are not page-derived.
 *
 * A key is a string on the wire with no length bound at all — `fenceTable` shipped page `<th>` prose
 * in key position, once per row, and the values-only walker of the day could not see it. So keys are
 * walked, and every key container needs a policy.
 *
 * `declaredBy` is the strong form: the key set IS an interface's declared property list, read out of
 * `src/types.ts` at test time. It is not a snapshot — a field added to the interface widens the
 * expectation immediately and the fixture that fails to emit it fails the completeness gate, which is
 * what makes a new raw field fail BY DEFAULT rather than on a reviewer's attention.
 */
export interface KeyPolicy {
  path: string;
  /** Interface in `src/types.ts` whose declared properties are exactly this container's key set. */
  declaredBy?: string;
  /**
   * Keys the emitted shape carries BEYOND the declared interface, because a seam widens it (an
   * intersection type). Named one by one so the widening is visible; a new one still fails.
   */
  extraKeys?: string[];
  /** For producer-shaped containers: the construction every key satisfies. */
  shape?: ValueShape;
  why?: string;
  producer?: string;
}

/**
 * An UNFENCED leaf with no construction behind it. Debt, recorded — never a safety justification.
 *
 * Most entries are live page-derived channels. Two are not, and their notes say so: one field has no
 * producer today, and one had its offered justification WITHDRAWN because the construction covered
 * only one of two producers. Both belong here rather than in ALLOWED_RAW, because "I could not cite
 * a construction" and "the construction is wrong" are the same answer as far as the guard goes.
 */
export interface KnownOpen {
  path: string;
  /** The register entry that already pins it, or the reason it is deferred. */
  note: string;
  /**
   * HOW THIS HOLE WILL CLOSE — and the reason this field exists at all.
   *
   * `crawl:$.links[].to` sat here as a recorded hole while #349 closed it AT THE PRODUCER rather
   * than with a fence. The drift gate only ever asked "is it still un-contained", so a
   * producer-side fix could never satisfy it: the entry would have stayed here forever, and its
   * bytes are NEVER shape-checked while it does. A hole that can never close is indistinguishable
   * from an allowlist entry with no justification, and it silently exempted the field a merged PR
   * had just fixed.
   *
   *  - `fence`       — a wrap at a seam will close it. The drift gate's "still un-contained" arm is
   *                    the trigger, and `shapeWhenClosed` is meaningless (a fenced value is a fence).
   *  - `producer`    — the fix constrains what the producer may write, and NO fence will ever appear.
   *                    The trigger is the SHAPE arm below: the emitted value must NOT yet satisfy
   *                    `shapeWhenClosed`. When it starts to, the fix has landed and the entry must
   *                    migrate to ALLOWED_RAW, where its bytes are checked on every run.
   *  - `unreachable` — no producer fills the field today. Neither trigger applies; the entry exists
   *                    so the day one appears is visible instead of silent.
   */
  closes: 'fence' | 'producer' | 'unreachable';
  /** REQUIRED for `closes: 'producer'`: the shape the value takes once the producer is constrained. */
  shapeWhenClosed?: ValueShape;
}

export const ALLOWED_RAW: RawValueAllowance[] = [
  // ── Dereferenceable identity ──────────────────────────────────────────────────────────────────
  // These are RAW ON PURPOSE and the reason is uniform: fencing a URL makes it undereferenceable, so
  // the agent could no longer act on the result at all. What is NOT uniform, and is the part nine
  // defects were made of, is whether the value really is one. So every one of them is checked to
  // parse as an absolute http(s) URL with no whitespace on every run — the `links[].to` test.
  { path: 'fetch:$.url', why: 'The resolved post-redirect URL the agent dereferences to re-fetch or cite the page. Fencing it would make the primary handle on the result unusable.', producer: 'src/tools/fetch.ts:1', shape: 'absolute-http-url' },
  { path: 'fetch:$.links[]', why: 'Outbound link targets, the input to a follow-up fetch or crawl. Raw so the agent can act on them.', producer: 'src/tools/fetch.ts:1', shape: 'absolute-http-url' },
  { path: 'fetch:$.images[]', why: 'Image URLs the caller may fetch or embed. Raw for the same dereference reason as links.', producer: 'src/tools/fetch.ts:1', shape: 'absolute-http-url' },
  { path: 'fetch:$.metadata.canonical_url', why: 'On content-fence.ts OPERATIONAL_KEYS: identity the agent matches and dereferences by.', producer: 'src/server/content-fence.ts:361', shape: 'absolute-http-url' },
  { path: 'fetch:$.metadata.og_image', why: 'On content-fence.ts OPERATIONAL_KEYS for the same reason as canonical_url.', producer: 'src/server/content-fence.ts:361', shape: 'absolute-http-url' },
  { path: 'fetch:$.site_data.url', why: 'A site extractor JSON leaf under the operational key `url`; fenceDeepValue keeps it raw via isOperationalKey.', producer: 'src/server/content-fence.ts:391', shape: 'absolute-http-url' },
  { path: 'fetch:$.evidence[].url', why: 'The passage source, raw so a citation resolves. fenceEvidence names url as operational alongside ids and spans.', producer: 'src/server/content-fence.ts:163', shape: 'absolute-http-url' },
  { path: 'crawl:$.pages[].url', why: 'Per-page identity, also the origin echoed in that page own fence marker. Raw so pages can be dereferenced.', producer: 'src/server/content-fence.ts:270', shape: 'absolute-http-url' },
  { path: 'crawl:$.pages[].evidence[].url', why: 'The evidence passage source locator on a crawled page, raw for the same dereference reason as the fetch evidence url.', producer: 'src/server/content-fence.ts:163', shape: 'absolute-http-url' },
  { path: 'cache:$.results[].url', why: 'The stored row key an agent re-fetches or diffs. May be an artifact URI rather than a web URL when the row came from a registered artifact provider.', producer: 'src/cache/artifact-registry.ts:1', shape: 'artifact-uri' },
  { path: 'cache:$.changes[].url', why: 'The re-checked URL; also the origin attributed to that entry fenced error region.', producer: 'src/server/content-fence.ts:525', shape: 'artifact-uri' },
  { path: 'search:$.results[].url', why: 'The result link — the single most acted-on field in a search response.', producer: 'src/server/content-fence.ts:453', shape: 'absolute-http-url' },
  { path: 'search:$.results[].favicon', why: 'Per-host icon URL for display, emitted only on include_favicon.', producer: 'src/server/content-fence.ts:453', shape: 'absolute-http-url' },
  { path: 'search:$.results[].image_url', why: 'Image location; the page-authored ALT beside it is fenced, the locator is not.', producer: 'src/server/content-fence.ts:457', shape: 'absolute-http-url' },
  { path: 'search:$.results[].thumbnail_url', why: 'Smaller preview image locator emitted beside image_url by image-search engines. A locator, not the page-authored alt beside it.', producer: 'src/server/content-fence.ts:453', shape: 'absolute-http-url' },
  { path: 'search:$.images[].url', why: 'Aggregated image locator. The page-authored prose on the same item — both `alt` and `title` — is fenced beside it; the locator is raw so the agent can still fetch or embed the image.', producer: 'src/server/content-fence.ts:463', shape: 'absolute-http-url' },
  { path: 'search:$.images[].source_url', why: 'The page hosting the image, and the origin attributed to the fenced alt and title regions on the same item.', producer: 'src/server/content-fence.ts:463', shape: 'absolute-http-url' },
  { path: 'search:$.images[].thumbnail_url', why: 'Smaller preview image locator on the aggregated image inventory; the prose fields on the same item (alt and title) are fenced. A locator, not a text channel.', producer: 'src/server/content-fence.ts:463', shape: 'absolute-http-url' },
  { path: 'search:$.citations[].url', why: 'Citation target; fenceCitations fences title and snippet and leaves the locator raw.', producer: 'src/server/content-fence.ts:197', shape: 'absolute-http-url' },
  { path: 'search:$.evidence[].url', why: 'The evidence passage source locator, raw so a quoted span resolves back to a page the caller can open.', producer: 'src/server/content-fence.ts:163', shape: 'absolute-http-url' },
  { path: 'search:$.highlights[].source_url', why: 'fenceHighlights names source_url and the indices as operational and fences text/source_title.', producer: 'src/server/content-fence.ts:175', shape: 'absolute-http-url' },
  { path: 'find_similar:$.results[].url', why: 'The similar-page link, the field the whole tool exists to hand back. May be an artifact URI when the row came from a registered provider.', producer: 'src/server/content-fence.ts:437', shape: 'artifact-uri' },
  { path: 'find_similar:$.evidence[].url', why: 'The evidence passage source locator, raw so a quoted span resolves back to a page the caller can open.', producer: 'src/server/content-fence.ts:163', shape: 'artifact-uri' },
  { path: 'research:$.sources[].url', why: 'Source locator; fenceResearchData fences title and markdown_content beside it.', producer: 'src/server/content-fence.ts:601', shape: 'absolute-http-url' },
  { path: 'research:$.citations[].url', why: 'The cited page locator. fenceCitations fences title and snippet and leaves this raw so a citation can be followed.', producer: 'src/server/content-fence.ts:197', shape: 'absolute-http-url' },
  { path: 'research:$.evidence[].url', why: 'The evidence passage source locator, raw so a quoted span resolves back to a page the caller can open.', producer: 'src/server/content-fence.ts:163', shape: 'absolute-http-url' },
  { path: 'research:$.brief.highlights[].source_url', why: 'The page a highlight was sliced out of. fenceHighlights names source_url and the indices operational and fences the text.', producer: 'src/server/content-fence.ts:175', shape: 'absolute-http-url' },
  { path: 'research:$.rejected_sources[].url', why: 'A candidate DROPPED before fetch. Pinned as a deliberate allowlist rather than an oversight by POLICY-1 in unfenced-siblings.test.ts.', producer: 'src/types.ts:907', shape: 'absolute-http-url' },
  { path: 'agent:$.sources[].url', why: 'The page each agent source was read from, raw so the caller can verify a claim against its source.', producer: 'src/server/content-fence.ts:638', shape: 'absolute-http-url' },
  { path: 'agent:$.evidence[].url', why: 'The evidence passage source locator, raw so a quoted span resolves back to a page the caller can open.', producer: 'src/server/content-fence.ts:163', shape: 'absolute-http-url' },
  { path: 'agent:$.result.url', why: 'A `url` leaf inside the schema-extraction record: fenceDeepValue keeps operational keys raw at any depth.', producer: 'src/server/content-fence.ts:391', shape: 'absolute-http-url' },
  { path: 'extract:structured:$.source_url', why: 'The extracted page identity; also the origin echoed in the fences of this same response.', producer: 'src/server/content-fence.ts:399', shape: 'absolute-http-url' },
  { path: 'extract:tables:$.source_url', why: 'The extracted page identity on the tables mode, and the origin echoed inside this response own fence markers.', producer: 'src/server/content-fence.ts:399', shape: 'absolute-http-url' },
  { path: 'extract:structured:$.data.jsonld[].url', why: 'schema.org `url` under OPERATIONAL_KEYS — the identity an agent follows out of a JSON-LD node.', producer: 'src/server/content-fence.ts:359', shape: 'absolute-http-url' },
  { path: 'extract:structured:$.data.jsonld[].sameAs[]', why: 'fenceDeepValue carries the parent key operational-ness onto ARRAY elements (rawLeaf), so `sameAs: [url, url]` stays dereferenceable.', producer: 'src/server/content-fence.ts:388', shape: 'absolute-http-url' },
  { path: 'extract:structured:$.data.jsonld[].@type', why: 'The schema.org TYPE of a JSON-LD node — the discriminator a consumer switches on to know it has a Product rather than an Article. On OPERATIONAL_KEYS for that reason. Page-authored, so it is shape-bounded to an identifier token rather than trusted as prose.', producer: 'src/server/content-fence.ts:359', shape: 'identifier' },
  { path: 'extract:structured:$.data.jsonld[].@context', why: 'The JSON-LD context IRI — a vocabulary identifier, matched by consumers, not read as prose.', producer: 'src/server/content-fence.ts:359', shape: 'absolute-http-url' },
  { path: 'watch:$.job.url', why: 'The watched URL, echoed back so the caller can correlate the job.', producer: 'src/watch/store.ts:1', shape: 'absolute-http-url' },
  { path: 'watch:$.jobs[].url', why: 'The watched URL on the list shape; the same stored row the singular job shape returns.', producer: 'src/watch/store.ts:1', shape: 'absolute-http-url' },
  { path: 'watch:$.changes_since_last[].url', why: 'The URL the scheduler re-fetched for this change report, raw so the caller can correlate it to its job.', producer: 'src/watch/store.ts:1', shape: 'absolute-http-url' },
  { path: 'crawl:$.links[].to', why: 'GRADUATED from KNOWN_OPEN when #349 landed. Every target now goes through normalizeLinkTarget (new URL(target, from)) and a null is DROPPED with a warn rather than passed through, so the field is URL-parseable and line-break-free by construction. The shape asserted is the MEASURED guarantee, not the one the field name implies: prose can still ride an opaque-path scheme on one line, which url-utils.ts says in its own words. Checking the weaker true property is what keeps this check able to fail on real data.', producer: 'src/crawl/url-utils.ts:62', shape: 'link-target' },
  { path: 'crawl:$.links[].from', why: 'The edge SOURCE is not a page-supplied target at all: addUniqueEdges is called with the URL the crawler is currently visiting, which came off its own frontier and was resolved before the page was fetched. Stronger than the `to` half, so it takes the stronger shape.', producer: 'src/crawl/crawler.ts:429', shape: 'absolute-http-url' },
  { path: 'watch:$.jobs[].notification', why: 'The webhook target, or the literal `inline`. A URL here is SSRF-guarded before delivery, and the caller supplied it in the first place.', producer: 'src/watch/ssrf.ts:1', shape: 'artifact-uri' },


  // ── The FAILURE envelope, one shape at two seams ──────────────────────────────────────────────
  // `stageErrorEnvelope` (src/server.ts) and `stageFailure` / `crawlCacheFailure`
  // (src/daemon/rest/dispatch.ts) are the whole population of hand-rolled failure envelopes. The
  // PROSE field is fenced at both; these are the three siblings that are not, and each is checked to
  // be a machine token or accounted for as operator text.
  { path: 'rest-error:$.error_reason', why: 'The STABLE MACHINE CODE of the failure envelope. A closed vocabulary the seam authors from a fixed table — statusForStageResult and statusForCrawlCacheError key their 400/502/503 rows on it, docs/rest-api.md publishes it, and both SDKs read it as THE code — so fencing it would break three consumers at once to contain nothing. Checked to BE a code on every run rather than assumed to be one.', producer: 'src/daemon/rest/errors.ts:24', shape: 'machine-code' },
  { path: 'rest-error:$.stage', why: 'The wigolo-authored stage enum (fetch / extract / validate / crawl / cache / search). Named in content-fence.ts as one of the two fields the error-shape fence must NOT wrap.', producer: 'src/server/content-fence.ts:97', shape: 'machine-code' },
  { path: 'rest-error:$.hint', why: 'Operator guidance, authored at every producer in the tree (daemon/rest/errors.ts literals, CODE_DESCRIPTIONS in fetch/error-describe.ts, the ssrf literals, tools/extract.ts, fetch/router.ts, ChallengeBlockedError default). No path interpolates response bytes into it. That premise is ONE caller away from false — ChallengeBlockedError accepts a hint argument — so it is pinned by the TRIP-1 tripwire in error-envelope-fence.test.ts rather than left tacit.', producer: 'src/server/content-fence.ts:98', shape: 'authored-prose' },
  { path: 'stage-error:$.error_reason', why: 'The MCP failure envelope publishes the machine CODE here — the two names are swapped relative to the producer shape, so this is the producer StageError.error. Same closed vocabulary and same three consumers as the REST half.', producer: 'src/server.ts:136', shape: 'machine-code' },
  { path: 'stage-error:$.stage', why: 'The wigolo-authored stage enum on the MCP failure envelope, identical to the REST half.', producer: 'src/server.ts:136', shape: 'machine-code' },
  { path: 'stage-error:$.hint', why: 'Operator guidance on the MCP failure envelope; the same producer population and the same TRIP-1 tripwire as the REST half.', producer: 'src/server/content-fence.ts:98', shape: 'authored-prose' },

  // ── Digests, timestamps, counters ─────────────────────────────────────────────────────────────
  { path: 'fetch:$.content_hash', why: 'SHA-256 of the full extracted markdown. A digest of content is not content: it is fixed-width hex a page cannot steer into prose.', producer: 'src/types.ts:130', shape: 'sha256-hex' },
  { path: 'fetch:$.previous_hash', why: 'The previous content digest. A digest of content is not content: fixed-width hex a page cannot steer into prose.', producer: 'src/types.ts:130', shape: 'sha256-hex' },
  { path: 'cache:$.changes[].previous_hash', why: 'The previous content digest on a ChangeReport, fixed-width hex rather than page bytes.', producer: 'src/types.ts:1301', shape: 'sha256-hex' },
  { path: 'cache:$.changes[].current_hash', why: 'The current content digest on a ChangeReport, fixed-width hex rather than page bytes.', producer: 'src/types.ts:1301', shape: 'sha256-hex' },
  { path: 'watch:$.changes_since_last[].previous_hash', why: 'The previous content digest on a watch change report, fixed-width hex rather than page bytes.', producer: 'src/types.ts:1301', shape: 'sha256-hex' },
  { path: 'watch:$.changes_since_last[].current_hash', why: 'The current content digest on a watch change report, fixed-width hex rather than page bytes.', producer: 'src/types.ts:1301', shape: 'sha256-hex' },
  { path: 'watch:$.job.last_content_hash', why: 'The digest the scheduler compares against on the next check.', producer: 'src/watch/scheduler.ts:1', shape: 'sha256-hex' },
  { path: 'watch:$.jobs[].last_content_hash', why: 'The comparison digest on the list shape; the same stored column the singular job returns.', producer: 'src/watch/scheduler.ts:1', shape: 'sha256-hex' },
  { path: 'fetch:$.cached_at', why: 'When the cached row was written. A wigolo-generated timestamp, never read off the page.', producer: 'src/cache/store.ts:1', shape: 'iso-8601' },
  { path: 'cache:$.results[].fetched_at', why: 'When wigolo wrote this cache row. A timestamp wigolo generated, never a date read off the page.', producer: 'src/cache/store.ts:1', shape: 'iso-8601' },
  { path: 'cache:$.stats.oldest', why: 'Aggregate over the cache MIN(fetched_at) — a timestamp wigolo wrote.', producer: 'src/cache/store.ts:1', shape: 'iso-8601' },
  { path: 'cache:$.stats.newest', why: 'Aggregate over the cache MAX(fetched_at), a timestamp wigolo generated when it wrote the newest row.', producer: 'src/cache/store.ts:1', shape: 'iso-8601' },
  { path: 'fetch:$.diff_summary', why: 'Line COUNTS. computeDiffSummary interpolates numbers only, which is why fencedInBandError names it as the field it deliberately does not wrap. Pinned to the count template so a producer that starts splicing text fails here.', producer: 'src/server/content-fence.ts:249', shape: 'diff-line-counts' },
  { path: 'cache:$.changes[].diff_summary', why: 'Line counts on a ChangeReport, from the same numbers-only computeDiffSummary template as the fetch field.', producer: 'src/server/content-fence.ts:249', shape: 'diff-line-counts' },
  { path: 'watch:$.changes_since_last[].diff_summary', why: 'Line counts on the watch surface, from the same numbers-only computeDiffSummary template.', producer: 'src/server/content-fence.ts:249', shape: 'diff-line-counts' },
  { path: 'fetch:$.screenshot', why: 'Base64 PNG bytes, not text. Fencing it would corrupt a payload the caller decodes.', producer: 'src/types.ts:118', shape: 'base64-blob' },
  { path: 'fetch:$.action_results[].screenshot', why: 'Per-action base64 capture, same reason as the top-level screenshot.', producer: 'src/types.ts:44', shape: 'base64-blob' },

  // ── Closed machine vocabularies ───────────────────────────────────────────────────────────────
  // Every one of these is checked to BE a machine token on each run. That is what distinguishes this
  // group from the assumption that produced the nine: `error_reason` is a code because it matches the
  // code shape here, not because a comment says so.
  { path: 'fetch:$.fetch_method', why: 'FetchMethod enum — which tier produced the bytes (http / tls / playwright / ...). Authored by the router, not the page.', producer: 'src/types.ts:155', shape: 'machine-code' },
  { path: 'fetch:$.screenshot_omitted', why: 'ScreenshotOmittedReason: a closed reason enum set by one predicate at response assembly.', producer: 'src/types.ts:113', shape: 'machine-code' },
  { path: 'fetch:$.challenge_class', why: 'ChallengeClass — the coarse class the challenge classifier assigned.', producer: 'src/types.ts:178', shape: 'machine-code' },
  { path: 'fetch:$.solve_method', why: 'SolveMethod: which rung of the solve ladder cleared the challenge. A closed enum the ladder writes, never the page.', producer: 'src/types.ts:184', shape: 'machine-code' },
  { path: 'fetch:$.fetch_failed', why: 'Partial-success marker; `blocked` is the canonical value, set when a site extractor refuses on a challenge body.', producer: 'src/types.ts:170', shape: 'machine-code' },
  { path: 'fetch:$.content_completeness.level', why: 'ContentCompleteness.level, full | partial | shell, the coarse render verdict a wigolo producer assigns.', producer: 'src/types.ts:210', shape: 'machine-code' },
  { path: 'fetch:$.content_completeness.reason', why: 'ContentCompleteness.reason: a closed taxonomy declared inline on the interface.', producer: 'src/types.ts:211', shape: 'machine-code' },
  { path: 'fetch:$.content_completeness.settled_by', why: 'ContentCompleteness.settled_by: probe | stability | budget | extraction.', producer: 'src/types.ts:226', shape: 'machine-code' },
  { path: 'fetch:$.action_results[].type', why: 'BrowserAction["type"] — the action the CALLER asked for, echoed back from its own input.', producer: 'src/types.ts:41', shape: 'machine-code' },
  { path: 'crawl:$.pages[].content_completeness.level', why: 'The render-completeness level carried through per crawled page from that page own fetch; the same closed enum.', producer: 'src/types.ts:210', shape: 'machine-code' },
  { path: 'crawl:$.pages[].content_completeness.reason', why: 'The completeness reason taxonomy carried through per crawled page from that page own fetch.', producer: 'src/types.ts:211', shape: 'machine-code' },
  { path: 'crawl:$.pages[].content_completeness.settled_by', why: 'Which producer settled the verdict, carried through per crawled page from that page own fetch.', producer: 'src/types.ts:226', shape: 'machine-code' },
  { path: 'crawl:$.pages[].challenge_class', why: 'The classified challenge class, carried through per crawled page from that page own fetch.', producer: 'src/types.ts:178', shape: 'machine-code' },
  { path: 'crawl:$.pages[].solve_method', why: 'Which solve rung cleared this page, carried through per crawled page from that page own fetch.', producer: 'src/types.ts:184', shape: 'machine-code' },
  { path: 'research:$.sources[].content_completeness.level', why: 'The render-completeness level carried through from the source fetch; a shell level excludes the source before synthesis.', producer: 'src/types.ts:210', shape: 'machine-code' },
  { path: 'research:$.sources[].content_completeness.reason', why: 'The completeness reason taxonomy carried through from the source fetch.', producer: 'src/types.ts:211', shape: 'machine-code' },
  { path: 'research:$.sources[].content_completeness.settled_by', why: 'Which producer settled the verdict, carried through from the source fetch.', producer: 'src/types.ts:226', shape: 'machine-code' },
  { path: 'research:$.rejected_sources[].reason', why: 'RejectedSource.reason enum. Pinned as a fixed vocabulary rather than a text channel by POLICY-2 in unfenced-siblings.test.ts.', producer: 'src/types.ts:908', shape: 'machine-code' },
  { path: 'research:$.rejected_sources[].stage', why: 'RejectedSource.stage: url-shape | content-gate | score-floor | shell-content. Pinned as a fixed vocabulary by POLICY-2.', producer: 'src/types.ts:909', shape: 'machine-code' },
  { path: 'research:$.depth', why: 'The caller own depth argument echoed back: quick | standard | comprehensive.', producer: 'src/types.ts:918', shape: 'machine-code' },
  { path: 'research:$.brief.query_type', why: 'ResearchBrief.query_type: comparison | how-to | concept | general, chosen by the classifier from a closed set.', producer: 'src/types.ts:984', shape: 'machine-code' },
  { path: 'research:$.brief.citation_graph[].confidence', why: 'CitationGraphEntry.confidence, high | medium | low, assigned by the corroboration counter rather than read off a page.', producer: 'src/types.ts:958', shape: 'machine-code' },
  { path: 'research:$.brief.sections.overview.cross_references[].confidence', why: 'CrossReference.confidence, high | medium, assigned by the corroboration counter rather than read off a page.', producer: 'src/types.ts:943', shape: 'machine-code' },
  { path: 'agent:$.steps[].action', why: 'AgentStep.action: plan | search | fetch | extract | synthesize. The step DETAIL beside it is fenced.', producer: 'src/types.ts:1029', shape: 'machine-code' },
  { path: 'find_similar:$.method', why: 'FindSimilarOutput.method: hybrid | embedding | fts5 | search.', producer: 'src/types.ts:1624', shape: 'machine-code' },
  { path: 'find_similar:$.results[].source', why: 'FindSimilarSource provenance tag: cache | search, or a registered artifact provider id.', producer: 'src/types.ts:1229', shape: 'machine-code' },
  { path: 'cache:$.results[].source', why: 'CacheItemSource: `cache`, or a registered artifact provider id — wigolo-registered, never page text.', producer: 'src/types.ts:1226', shape: 'machine-code' },
  { path: 'cache:$.results[].truncated', why: 'Budget marker, partial | omitted, set by the output-budget trimmer so an emptied body does not read as a blank page.', producer: 'src/types.ts:1256', shape: 'machine-code' },
  // ── S14-2 time axis ───────────────────────────────────────────────────────────────────────────
  // The page-derived leaves of these shapes (version.markdown, version.title,
  // version_list.versions[].title) are FENCED in fenceCacheData and so never reach here. What is
  // left is the coordinate system around them: a URL the agent dereferences, digests it compares,
  // timestamps wigolo wrote, and two wigolo-authored sentences.
  { path: 'cache:$.version.url', why: 'The page the retained body belongs to; the handle an agent re-fetches or diffs against, and the origin attributed to that body own fence marker. readVersions passes the NORMALIZED url here, so it is WHATWG-parsed output rather than the caller string: no CR/LF survives and spaces are percent-encoded, which is what makes the artifact-uri shape hold by construction.', producer: 'src/cache/version-read.ts:300', shape: 'artifact-uri' },
  { path: 'cache:$.version.content_hash', why: 'SHA-256 over the retained markdown, computed by cacheContent before the row is written. A digest of content is not content — fixed-width hex a page cannot steer into prose.', producer: 'src/cache/store.ts:100', shape: 'sha256-hex' },
  { path: 'cache:$.version.observed_at', why: 'The url_versions.fetched_at wigolo wrote when it observed this body. A wigolo clock reading, never a date parsed off the page.', producer: 'src/cache/store.ts:171', shape: 'iso-8601' },
  { path: 'cache:$.version.requested_at', why: 'The caller own `at` normalized to zone-less UTC by toVersionTimestamp, which only ever emits that fixed shape or null. Caller-supplied, not page-supplied.', producer: 'src/cache/version-read.ts:136', shape: 'iso-8601' },
  { path: 'cache:$.version.source', why: 'CacheItemSource provenance tag, the same wigolo-registered vocabulary results[].source carries.', producer: 'src/types.ts:1226', shape: 'machine-code' },
  { path: 'cache:$.version.truncated', why: 'Budget marker, partial | omitted, set by the same output-budget trimmer the results[] rows go through.', producer: 'src/types.ts:1256', shape: 'machine-code' },
  { path: 'cache:$.version_not_retained.url', why: 'The page asked about, echoed back so the miss is attributable. The NORMALIZED form, same WHATWG-parsed value as the hit shape, so the whitespace the artifact-uri shape forbids cannot reach it.', producer: 'src/cache/version-read.ts:290', shape: 'artifact-uri' },
  { path: 'cache:$.version_not_retained.requested_at', why: 'The normalized `at` the miss is reported against, from the same toVersionTimestamp output as the hit shape.', producer: 'src/cache/version-read.ts:136', shape: 'iso-8601' },
  { path: 'cache:$.version_list.url', why: 'The page whose retained versions are listed; the handle the agent pairs each content_hash with. The NORMALIZED form, as on the other two arms.', producer: 'src/cache/version-read.ts:305', shape: 'artifact-uri' },
  { path: 'cache:$.version_list.versions[].content_hash', why: 'SHA-256 over that retained body, the handle diff old.content_hash resolves. Same digest column as the hit shape.', producer: 'src/cache/store.ts:100', shape: 'sha256-hex' },
  { path: 'cache:$.version_list.versions[].observed_at', why: 'The url_versions.fetched_at wigolo wrote for that entry — a wigolo clock reading, never page text.', producer: 'src/cache/store.ts:171', shape: 'iso-8601' },
  { path: 'cache:$.version_list.note', why: 'The VERSION_LIST_NOTE module constant, stating that retention is bounded and swept oldest-first across URLs so gaps are not evidence the page held still. A fixed literal with no interpolation slot — nothing, caller or page, is spliced into it.', producer: 'src/cache/version-read.ts:86', shape: 'authored-prose', pattern: /^Retained versions only, newest first[\s\S]*$/ },
  { path: 'cache:$.version_not_retained.reason', why: 'The fixed sentence the point-in-time miss carries, saying nothing retained matches that moment and that this is not evidence the page was unchanged. A literal in readVersions with no interpolation slot.', producer: 'src/cache/version-read.ts:294', shape: 'authored-prose', pattern: /^No version of this page observed at or before that time is retained\.[\s\S]*$/ },
  { path: 'extract:structured:$.mode', why: 'The caller own mode argument echoed back for correlation; the input schema validates it against a closed enum on the way in.', producer: 'src/types.ts:1386', shape: 'machine-code' },
  { path: 'extract:tables:$.mode', why: 'The caller own mode argument echoed back on the tables shape, exactly as on the structured shape above.', producer: 'src/types.ts:1386', shape: 'machine-code' },
  { path: 'diff:$.hunks[].change_type', why: 'DiffHunk.change_type, added | removed | modified, assigned by the LCS edit script rather than by page bytes.', producer: 'src/types.ts:1459', shape: 'machine-code' },
  { path: 'watch:$.job.status', why: 'WatchJobStatus, active | paused | errored, a lifecycle state the scheduler writes.', producer: 'src/types.ts:1497', shape: 'machine-code' },
  { path: 'watch:$.jobs[].status', why: 'WatchJobStatus on the list shape; the same closed lifecycle enum as the singular job above.', producer: 'src/types.ts:1497', shape: 'machine-code' },
  { path: 'watch:$.job.notification', why: 'The literal inline when the caller asked for in-band delivery rather than a webhook target.', producer: 'src/types.ts:1523', shape: 'machine-code' },
  { path: 'search:$.synthesis_status', why: 'The single literal quota_exceeded, set when format=answer hit a provider quota wall and fell back to a heuristic.', producer: 'src/types.ts:955', shape: 'machine-code' },
  { path: 'search:$.results[].freshness_signal.confidence', why: 'FreshnessConfidence enum: extracted | inferred-url | inferred-html | inferred-llm | unknown.', producer: 'src/types.ts:610', shape: 'machine-code' },
  { path: 'search:$.engine_telemetry[].reason', why: 'Why dispatch was skipped. A single literal, breaker_open, written by the circuit breaker when it rejects a dispatch — the engine is never contacted, so no response bytes exist to reach this field.', producer: 'src/types.ts:582', shape: 'machine-code' },
  { path: 'search:$.engine_telemetry[].outcome', why: 'EngineTelemetry.outcome, ok | error | skipped, the dispatch result the pool recorded for that engine.', producer: 'src/types.ts:577', shape: 'machine-code' },
  { path: 'search:$.engine_pool.reasons[]', why: 'Pool degradation events from a fixed set (thin_pool, starvation_redispatch, pool_collapsed).', producer: 'src/types.ts:783', shape: 'machine-code' },
  { path: 'search:$.query_understanding.intent', why: 'QueryUnderstanding.intent: general | news | code | docs | papers | images.', producer: 'src/types.ts:794', shape: 'machine-code' },
  { path: 'search:$.query_understanding.language', why: 'A detected language tag for the CALLER query, from the language classifier, never from a result body.', producer: 'src/types.ts:797', shape: 'machine-code' },
  { path: 'search:$.fallback_signal', why: 'Hybrid-mode signal names, `+`-joined from a fixed set of signal identifiers.', producer: 'src/types.ts:966', shape: 'machine-code' },
  { path: 'search:$.engine_telemetry[].name', why: 'The engine adapter id on a telemetry row, drawn from wigolo own engine registry rather than from any response.', producer: 'src/types.ts:574', shape: 'machine-code' },
  { path: 'search:$.engine_warnings[].engine', why: 'The engine adapter id on a warning row, drawn from wigolo own engine registry rather than from any response.', producer: 'src/types.ts:599', shape: 'machine-code' },
  { path: 'search:$.engine_outcomes[].engine', why: 'The engine adapter id on an outcome row, drawn from wigolo own engine registry rather than from any response.', producer: 'src/types.ts:565', shape: 'machine-code' },
  { path: 'search:$.engine_warnings[].code', why: 'Stable failure code: http_4xx / http_5xx / http_<code> / error — assembled from the STATUS NUMBER, never from the response body.', producer: 'src/types.ts:600', shape: 'machine-code' },
  { path: 'search:$.engines_used[]', why: 'Engine ids that contributed at least one result to the fused list, drawn from wigolo own engine registry.', producer: 'src/types.ts:676', shape: 'machine-code' },
  { path: 'search:$.images[].engine', why: 'Short engine identifier on an aggregated image (ddg-image, brave-image).', producer: 'src/types.ts:543', shape: 'machine-code' },
  { path: 'search:$.results[].published_date', why: 'Publication date as the engine reported it, normalised to ISO before it reaches the response.', producer: 'src/types.ts:646', shape: 'iso-8601' },
  { path: 'search:$.results[].cached_at', why: 'When wigolo wrote the cache row this result was served from. A wigolo-generated timestamp.', producer: 'src/cache/store.ts:1', shape: 'iso-8601' },
  { path: 'search:$.results[].freshness_signal.published_date', why: 'The extracted or inferred publication date in ISO form; the confidence tag beside it says which of the two it is.', producer: 'src/types.ts:615', shape: 'iso-8601' },
  { path: 'search:$.query_understanding.date_hint.fromDate', why: 'Lower date bound the classifier inferred from the CALLER query, in ISO form.', producer: 'src/types.ts:796', shape: 'iso-8601' },
  { path: 'search:$.query_understanding.date_hint.toDate', why: 'Upper date bound the classifier inferred from the CALLER query, in ISO form.', producer: 'src/types.ts:796', shape: 'iso-8601' },

  // ── Producer templates ────────────────────────────────────────────────────────────────────────
  // Constructions too specific for a shared shape. The template is the guarantee, so the template is
  // what is asserted — a looser shape would accept strings the producer cannot emit.
  { path: 'extract:structured:$.error', why: 'The ONLY success-shape producer is the named-schema miss at src/tools/extract.ts:466, which interpolates input.named_schema into a fixed sentence — and named_schema is validated against NAMED_SCHEMAS before it gets there, so the variable part is one of seven literals. Every other `error:` in that file is on an ok:false return and reaches the failure envelope instead.', producer: 'src/tools/extract.ts:466', shape: 'machine-code', pattern: /^No (Article|Recipe|Product|CodeSnippet|Paper|EventListing|JobPosting) data found on page$/ },
  { path: 'research:$.brief.sections.gaps[].entity', why: 'The object form of a gap has exactly one producer, detectEntityGaps (src/research/entity-extractor.ts:62), and its entity comes only from extractNamedEntities(question) — the CALLER own question, never a fetched body. The two other gap producers return the STRING form, which fenceBrief fences. The inversion is real but harmless: the fenced `reason` is a constant and the raw `entity` is the variable one, and that variable is the caller own text.', producer: 'src/research/entity-extractor.ts:62', shape: 'machine-code', pattern: /^(?:[A-Z][A-Za-z0-9]+|[^"\u201d]{1,80})$/ },

  { path: 'search:$.results[].evidence_score.explanation', why: 'Every parameter of explainEvidence is typed `number` (orchestrator.ts:36-42) — a type-level barrier at the function boundary, not a convention, so no title, snippet, url or host can reach it even though the scorers upstream READ those. They collapse to a number first. rerank-fold.ts:329 appends one more numeric token. It was in the unverifiable prose class only because I had not read the producer.', producer: 'src/search/core/orchestrator.ts:36', shape: 'machine-code', pattern: /^base=\d+\.\d{3}, domain=\d+\.\d{2}, lex=\d+\.\d{2}(?:, recency=\d+\.\d{2})?, engines=\d+(?:, xenc=\d+\.\d{2})?$/ },

  // ── Wigolo-minted handles ─────────────────────────────────────────────────────────────────────
  { path: 'fetch:$.evidence[].citation_id', why: 'A wigolo-minted stable handle the caller quotes; fenceEvidence names it operational beside url and span.', producer: 'src/server/content-fence.ts:163', shape: 'machine-code' },
  { path: 'crawl:$.pages[].evidence[].citation_id', why: 'Same minted-handle construction as the fetch evidence citation_id above; fenceEvidence applies it identically on every tool that carries evidence.', producer: 'src/server/content-fence.ts:163', shape: 'machine-code' },
  { path: 'search:$.evidence[].citation_id', why: 'Same minted-handle construction as the fetch evidence citation_id above; fenceEvidence applies it identically on every tool that carries evidence.', producer: 'src/server/content-fence.ts:163', shape: 'machine-code' },
  { path: 'find_similar:$.evidence[].citation_id', why: 'Same minted-handle construction as the fetch evidence citation_id above; fenceEvidence applies it identically on every tool that carries evidence.', producer: 'src/server/content-fence.ts:163', shape: 'machine-code' },
  { path: 'research:$.evidence[].citation_id', why: 'Same minted-handle construction as the fetch evidence citation_id above; fenceEvidence applies it identically on every tool that carries evidence.', producer: 'src/server/content-fence.ts:163', shape: 'machine-code' },
  { path: 'agent:$.evidence[].citation_id', why: 'Same minted-handle construction as the fetch evidence citation_id above; fenceEvidence applies it identically on every tool that carries evidence.', producer: 'src/server/content-fence.ts:163', shape: 'machine-code' },
  { path: 'search:$.citations[].citation_id', why: 'Minted handle on a Citation; the title and snippet beside it are fenced.', producer: 'src/server/content-fence.ts:197', shape: 'machine-code' },
  { path: 'research:$.citations[].citation_id', why: 'Same minted-handle construction as the search citation_id above; fenceCitations applies it identically on both tools that carry citations.', producer: 'src/server/content-fence.ts:197', shape: 'machine-code' },
  { path: 'watch:$.job.id', why: 'A wigolo-minted job handle the caller passes back to check / pause / delete.', producer: 'src/watch/store.ts:1', shape: 'machine-code' },
  { path: 'watch:$.jobs[].id', why: 'Same wigolo-minted job handle as the singular job shape above; list and singular are the same stored row read twice.', producer: 'src/watch/store.ts:1', shape: 'machine-code' },

  // ── Caller-supplied, echoed back ──────────────────────────────────────────────────────────────
  // These carry the CALLER own bytes, not an origin. The caller already had them; echoing them adds
  // no channel a page can write to.
  { path: 'search:$.query', why: 'The caller own query string, echoed for correlation. No producer reads it off a page.', producer: 'src/search/core/core-provider.ts:878', shape: 'authored-prose' },
  { path: 'search:$.queries_executed[]', why: 'The multi-query variants wigolo derived from the caller own query, plus the caller own array when it passed one.', producer: 'src/search/core/core-provider.ts:885', shape: 'authored-prose' },
  { path: 'search:$.query_understanding.entities[]', why: 'Entities the classifier extracted from the CALLER query, not from any result.', producer: 'src/search/core/query-understanding.ts:1', shape: 'authored-prose' },
  { path: 'search:$.query_understanding.rewrites[]', why: 'Alternative phrasings the classifier proposed for the CALLER own query. Nothing in this field is read from a result.', producer: 'src/search/core/query-understanding.ts:1', shape: 'authored-prose' },
  { path: 'search:$.query_understanding.compound_terms[]', why: 'Rare/compound tokens detected structurally in the CALLER query.', producer: 'src/search/core/query-understanding.ts:1', shape: 'authored-prose' },
  { path: 'search:$.domain_filter.include_domains[]', why: 'The caller own include_domains scope, echoed so the caller can widen it.', producer: 'src/search/core/domain-filter-cause.ts:56', shape: 'authored-prose' },
  { path: 'watch:$.job.selector', why: 'The CSS selector the caller supplied when creating the job, echoed back so the job is self-describing.', producer: 'src/tools/watch.ts:109', shape: 'authored-prose' },
  { path: 'watch:$.jobs[].selector', why: 'The caller own CSS selector on the list shape; the same stored column the singular job returns.', producer: 'src/watch/store.ts:25', shape: 'authored-prose' },

  // ── Operator prose ────────────────────────────────────────────────────────────────────────────
  // No predicate can tell authored prose from page prose byte-for-byte, so the check for this class
  // is the PRODUCER POPULATION: the set of src/ files that assign the field. A new assigning file is
  // exactly how "wigolo authors this" stops being true, and it fails the gate.
  { path: 'search:$.notice', why: 'Depth-tier advisory telling the caller to retry at a higher search_depth.', producer: 'src/search/core/core-provider.ts:958', shape: 'authored-prose' },
  { path: 'search:$.ranking_notice', why: 'States plainly that reranking contributed no ordering signal. A dedicated field precisely because `notice` gets overwritten on the stream_answer path.', producer: 'src/search/core/rerank-fold.ts:139', shape: 'authored-prose' },
  { path: 'search:$.synthesis_advice', why: 'Operator guidance for enabling synthesis (which env var to set).', producer: 'src/search/answer-synthesis.ts:244', shape: 'authored-prose' },
  { path: 'search:$.synthesis_provider', why: 'Which cloud LLM adapter ran the synthesis — a wigolo adapter id.', producer: 'src/search/answer-synthesis.ts:346', shape: 'authored-prose' },
  { path: 'search:$.synthesis_model', why: 'resolveModel echoes WIGOLO_LLM_MODEL_<PROVIDER> / WIGOLO_LLM_MODEL with NO allow-list, falling back to four hard-coded defaults. So it is NOT a closed set — it is OPERATOR ENV, which is caller-side configuration rather than a network origin. Recorded as the weaker claim it is rather than the closed-vocabulary one I first wrote.', producer: 'src/integrations/cloud/llm/model-select.ts:28', shape: 'authored-prose' },
  { path: 'search:$.engine_warnings[].hint', why: 'Assigned ONLY from ENGINE_AUTH_HINTS (src/search/core/engine-warnings.ts:32), a three-literal table naming WIGOLO_GITHUB_TOKEN or BRAVE_API_KEY. It is a lookup keyed on the engine name, so no response byte can reach it — a closed vocabulary, not free prose, which is why it is here rather than in KNOWN_OPEN beside its `message` sibling.', producer: 'src/search/core/engine-warnings.ts:32', shape: 'authored-prose' },
  { path: 'search:$.brand_collision_warning.suggested_rewrites[]', why: 'Every element is a wigolo template over the CALLER query or a static-lexicon term; subjectCollisionRewrites takes the query alone and never sees the host attrition set, so the leak that put hostnames into its `reason` sibling does NOT reach this array. That separation was measured, not assumed — the two fields are built by different functions.', producer: 'src/search/core/brand-collision.ts:224', shape: 'authored-prose' },
  { path: 'search:$.engine_pool.alternatives[]', why: 'Remedies that widen a collapsed pool, authored beside the pool-health computation.', producer: 'src/search/core/core-provider.ts:190', shape: 'authored-prose' },
  { path: 'find_similar:$.cold_start', why: 'The documented cold-start advisory the tool contract tells callers to relay verbatim.', producer: 'src/search/find-similar.ts:331', shape: 'authored-prose' },
  { path: 'cache:$.truncation.hint', why: 'Operator guidance for retrieving the rows an output budget trimmed away, a wigolo instruction rather than page text.', producer: 'src/cache/output-budget.ts:133', shape: 'authored-prose' },
  { path: 'cache:$.changes_truncation.hint', why: 'Operator guidance for checking the rows the change-check row cap stopped short of, a wigolo instruction.', producer: 'src/cache/output-budget.ts:120', shape: 'authored-prose' },
  { path: 'research:$.warning', why: 'Says the run succeeded on degraded terms (the content gate rejected every source and was waived).', producer: 'src/research/pipeline.ts:295', shape: 'authored-prose' },
  { path: 'agent:$.warning', why: 'Says the run succeeded on degraded terms because its sources failed, so the payload is weaker than it looks.', producer: 'src/agent/pipeline.ts:158', shape: 'authored-prose' },
];

export const KEY_POLICIES: KeyPolicy[] = [
  {
    path: 'compat:map:${key}',
    why: 'The compat failure envelope is the vendor byte contract, two keys wide: firecrawl-compat.ts:266 emits exactly { success: false, error: message }. It deliberately does not match wigolo own error envelope, which is the whole point of a compatibility surface.',
    producer: 'src/daemon/rest/firecrawl-compat.ts:266',
    shape: 'machine-code',
  },
  {
    path: 'rest-error:${key}',
    why: 'The REST failure envelope is hand-rolled by errorEnvelope with a fixed key set: ok / error / error_reason, plus stage and hint when present. It is not a src/types.ts interface, so the policy is a shape bound plus this citation rather than a declared property list.',
    producer: 'src/daemon/rest/errors.ts:24',
    shape: 'machine-code',
  },
  {
    path: 'stage-error:${key}',
    why: 'The MCP failure envelope is hand-rolled by stageErrorEnvelope with the same fixed key set minus ok. Same reason as the REST half for a shape bound rather than a declared list.',
    producer: 'src/server.ts:136',
    shape: 'machine-code',
  },
  { path: 'fetch:${key}', declaredBy: 'FetchOutput' },
  { path: 'fetch:$.evidence[]{key}', declaredBy: 'EvidenceItem' },
  { path: 'fetch:$.evidence[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'fetch:$.content_completeness{key}', declaredBy: 'ContentCompleteness' },
  { path: 'fetch:$.action_results[]{key}', declaredBy: 'ActionResult' },
  {
    path: 'fetch:$.metadata{key}',
    why: 'FetchOutput.metadata is an inline object literal on the interface, so its key set is declared at src/types.ts:87 rather than by a named interface. Enumerated there and nowhere else.',
    producer: 'src/types.ts:87',
    shape: 'machine-code',
  },
  { path: 'search:${key}', declaredBy: 'SearchOutput' },
  { path: 'search:$.results[]{key}', declaredBy: 'SearchResultItem' },
  { path: 'search:$.results[].freshness_signal{key}', declaredBy: 'FreshnessSignal' },
  { path: 'search:$.results[].evidence_score{key}', declaredBy: 'EvidenceScore' },
  { path: 'search:$.results[]._score_breakdown{key}', declaredBy: 'ScoreBreakdown' },
  { path: 'search:$.citations[]{key}', declaredBy: 'Citation' },
  { path: 'search:$.highlights[]{key}', declaredBy: 'Highlight' },
  { path: 'search:$.highlights[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'search:$.evidence[]{key}', declaredBy: 'EvidenceItem' },
  { path: 'search:$.evidence[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'search:$.images[]{key}', declaredBy: 'ImageItem' },
  { path: 'search:$.engine_warnings[]{key}', declaredBy: 'EngineWarning' },
  { path: 'search:$.engine_telemetry[]{key}', declaredBy: 'EngineTelemetry' },
  { path: 'search:$.engine_outcomes[]{key}', declaredBy: 'EngineOutcomeSummary' },
  { path: 'search:$.engine_pool{key}', declaredBy: 'EnginePoolHealth' },
  { path: 'search:$.query_understanding{key}', declaredBy: 'QueryUnderstanding' },
  {
    path: 'search:$.results[].evidence_score.components{key}',
    why: 'EvidenceScore.components is an inline object literal declared at src/types.ts:1061; every key is a scoring component wigolo computes.',
    producer: 'src/types.ts:1061',
    shape: 'machine-code',
  },
  {
    path: 'search:$.brand_collision_warning{key}',
    why: 'SearchOutput.brand_collision_warning is an inline object literal declared at src/types.ts:745.',
    producer: 'src/types.ts:745',
    shape: 'machine-code',
  },
  {
    path: 'search:$.domain_filter{key}',
    why: 'SearchOutput.domain_filter is an inline object literal declared at src/types.ts:1008.',
    producer: 'src/types.ts:1008',
    shape: 'machine-code',
  },
  {
    path: 'search:$.query_understanding.date_hint{key}',
    why: 'QueryUnderstanding.date_hint is an inline object literal declared at src/types.ts:796; its two keys are camelCase rather than the snake_case the rest of the response uses, which is why the shape here is identifier and not machine-code.',
    producer: 'src/types.ts:796',
    shape: 'identifier',
  },
  { path: 'crawl:${key}', declaredBy: 'CrawlOutput' },
  { path: 'crawl:$.pages[]{key}', declaredBy: 'CrawlResultItem' },
  { path: 'crawl:$.pages[].evidence[]{key}', declaredBy: 'EvidenceItem' },
  { path: 'crawl:$.pages[].evidence[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'crawl:$.pages[].content_completeness{key}', declaredBy: 'ContentCompleteness' },
  { path: 'crawl:$.links[]{key}', declaredBy: 'LinkEdge' },
  {
    // The seam types the map arm as `MapOutput & { crawled: number }` (content-fence.ts:23), so the
    // emitted key set is the intersection and a bare MapOutput check would report `crawled` as
    // undeclared. `extraKeys` names the widening EXPLICITLY rather than dropping the declared check
    // and settling for a shape bound — the declared list is the stronger of the two and is kept.
    path: 'crawl:map:${key}',
    declaredBy: 'MapOutput',
    extraKeys: ['crawled'],
    why: 'handleCrawl returns a crawl OR a map; the map arm is MapOutput widened with the crawler own crawled counter, and content-fence.ts names that intersection type explicitly.',
    producer: 'src/server/content-fence.ts:23',
  },
  { path: 'cache:${key}', declaredBy: 'CacheOutput' },
  { path: 'cache:$.results[]{key}', declaredBy: 'CacheResultItem' },
  { path: 'cache:$.stats{key}', declaredBy: 'CacheStats' },
  { path: 'cache:$.changes[]{key}', declaredBy: 'ChangeReport' },
  { path: 'cache:$.truncation{key}', declaredBy: 'CacheTruncation' },
  { path: 'cache:$.version{key}', declaredBy: 'CacheVersionResult' },
  { path: 'cache:$.version_not_retained{key}', declaredBy: 'CacheVersionNotRetained' },
  { path: 'cache:$.version_list{key}', declaredBy: 'CacheVersionList' },
  { path: 'cache:$.version_list.versions[]{key}', declaredBy: 'CacheVersionListEntry' },
  { path: 'cache:$.changes_truncation{key}', declaredBy: 'ChangesTruncation' },
  { path: 'extract:structured:${key}', declaredBy: 'ExtractOutput' },
  { path: 'extract:tables:${key}', declaredBy: 'ExtractOutput' },
  { path: 'extract:structured:$.data{key}', declaredBy: 'StructuredData' },
  { path: 'extract:structured:$.data.tables[]{key}', declaredBy: 'TableData' },
  { path: 'extract:tables:$.data[]{key}', declaredBy: 'TableData' },
  { path: 'extract:structured:$.data.definitions[]{key}', declaredBy: 'DefinitionPair' },
  { path: 'extract:structured:$.data.chart_hints[]{key}', declaredBy: 'ChartHint' },
  { path: 'extract:structured:$.data.key_value_pairs[]{key}', declaredBy: 'KeyValuePair' },
  {
    // F7 — the fix for the sharpest of the nine. Row keys are no longer the page `<th>` text; they are
    // wigolo-authored positional handles aligned by INDEX to the already-fenced `headers[]`. The shape
    // check is what makes that a verified construction rather than a claim about the past.
    path: 'extract:structured:$.data.tables[].rows[]{key}',
    why: 'Row keys are wigolo-authored `col_N` handles, aligned by index to the fenced headers[]. Page text cannot occupy a key position at all — which is the only fix that closes the channel, since a fenced key is not dereferenceable and a sanitised one is still prose.',
    producer: 'src/server/content-fence.ts:316',
    shape: 'column-handle',
  },
  {
    path: 'extract:tables:$.data[].rows[]{key}',
    why: 'The same `col_N` construction on the tables mode. Both modes reach fenceTable, which is why the fix had to land in fenceRow rather than at one entry point.',
    producer: 'src/server/content-fence.ts:316',
    shape: 'column-handle',
  },
  { path: 'find_similar:${key}', declaredBy: 'FindSimilarOutput' },
  { path: 'find_similar:$.results[]{key}', declaredBy: 'FindSimilarResult' },
  { path: 'find_similar:$.results[].match_signals{key}', declaredBy: 'MatchSignals' },
  { path: 'find_similar:$.results[].ranking_debug{key}', declaredBy: 'RankingDebug' },
  { path: 'find_similar:$.evidence[]{key}', declaredBy: 'EvidenceItem' },
  { path: 'find_similar:$.evidence[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'research:${key}', declaredBy: 'ResearchOutput' },
  { path: 'research:$.sources[]{key}', declaredBy: 'ResearchSource' },
  { path: 'research:$.sources[].content_completeness{key}', declaredBy: 'ContentCompleteness' },
  { path: 'research:$.citations[]{key}', declaredBy: 'Citation' },
  { path: 'research:$.evidence[]{key}', declaredBy: 'EvidenceItem' },
  { path: 'research:$.evidence[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'research:$.rejected_sources[]{key}', declaredBy: 'RejectedSource' },
  { path: 'research:$.brief{key}', declaredBy: 'ResearchBrief' },
  { path: 'research:$.brief.highlights[]{key}', declaredBy: 'Highlight' },
  { path: 'research:$.brief.highlights[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'research:$.brief.citation_graph[]{key}', declaredBy: 'CitationGraphEntry' },
  { path: 'research:$.brief.sections.overview.cross_references[]{key}', declaredBy: 'CrossReference' },
  { path: 'research:$.brief.sections.comparison.tradeoffs[]{key}', declaredBy: 'ComparisonTradeoff' },
  {
    path: 'research:$.brief.sections{key}',
    why: 'ResearchBrief.sections is an inline object literal declared at src/types.ts:966.',
    producer: 'src/types.ts:966',
    shape: 'machine-code',
  },
  {
    path: 'research:$.brief.sections.overview{key}',
    why: 'The overview block is an inline object literal declared at src/types.ts:967.',
    producer: 'src/types.ts:967',
    shape: 'machine-code',
  },
  {
    path: 'research:$.brief.sections.comparison{key}',
    why: 'The comparison block is an inline object literal declared at src/types.ts:971.',
    producer: 'src/types.ts:971',
    shape: 'machine-code',
  },
  {
    path: 'research:$.brief.sections.gaps[]{key}',
    why: 'A gap entry is an inline `{ entity, reason }` literal declared at src/types.ts:980.',
    producer: 'src/types.ts:980',
    shape: 'machine-code',
  },
  { path: 'agent:${key}', declaredBy: 'AgentOutput' },
  {
    // The schema path: `AgentOutput.result` is the record the extractor filled against the CALLER own
    // JSON Schema, so its keys are the caller property names, not page text. The page decides the
    // VALUES — which fenceDeepValue fences — and never the key set. Shape-bounded rather than
    // enumerated because the caller, not wigolo, chooses the names.
    path: 'agent:$.result{key}',
    why: 'Keys of the schema-extraction record are the property names from the CALLER own JSON Schema, not names lifted off the page; the extractor fills declared properties and drops the rest. The page-chosen values under them are deep-fenced.',
    producer: 'src/server/content-fence.ts:632',
    shape: 'identifier',
  },
  {
    path: 'agent:$.result.nested{key}',
    why: 'A nested object inside the same schema-extraction record; its key set comes from the caller own nested schema for the same reason as the top level.',
    producer: 'src/server/content-fence.ts:632',
    shape: 'identifier',
  },
  { path: 'agent:$.sources[]{key}', declaredBy: 'AgentSource' },
  { path: 'agent:$.steps[]{key}', declaredBy: 'AgentStep' },
  { path: 'agent:$.evidence[]{key}', declaredBy: 'EvidenceItem' },
  { path: 'agent:$.evidence[].source_span{key}', declaredBy: 'SourceSpan' },
  { path: 'diff:${key}', declaredBy: 'DiffOutput' },
  { path: 'diff:$.hunks[]{key}', declaredBy: 'DiffHunk' },
  { path: 'diff:$.summary{key}', declaredBy: 'DiffSummary' },
  { path: 'watch:${key}', declaredBy: 'WatchJobOutput' },
  { path: 'watch:$.job{key}', declaredBy: 'WatchJob' },
  { path: 'watch:$.jobs[]{key}', declaredBy: 'WatchJob' },
  { path: 'watch:$.changes_since_last[]{key}', declaredBy: 'ChangeReport' },
];

/**
 * LIVE, PAGE-DERIVED, UNFENCED — recorded so the invariant is green on a clean tip while the debt
 * stays enumerable. Every entry is a channel, not a justification.
 *
 * This list is DRIFT-GATED in both directions. An entry that becomes contained fails the test with
 * "graduate it", because a silently-closing hole is how a register rots into folklore; and a leaf not
 * on it fails as a new defect. That is the same graduation discipline GAP-5 followed into ENV-10.
 */
export const KNOWN_OPEN: KnownOpen[] = [
  // ── FOUND BY TIGHTENING THIS FILE'S OWN ALLOWLIST. Each of these was an entry I had written and
  //    justified; tracing the producer falsified the justification. `search:$.warning` was one of
  //    them and is now CLOSED — it is fenced at content-fence.ts, and the production comment that
  //    had been quoted as its justification is corrected in place.
  { path: 'search:$<bare block>', note: 'PARTIAL, and downgraded rather than closed. search-response.ts:31 re-emits the warning as a bare `[wigolo notice] …` text block OUTSIDE the JSON, and it reads `data.warning` AFTER fenceSearchData — so now that the field is fenced this block is wigolo prefix + one closed region, which the walker calls `partial`, not `contained`. That is a real improvement (the provider bytes are inside a nonce-matched region) and still not containment: the leaf as a whole is not one region, and a consumer scanning the block from its start reads wigolo-authored bytes first. Closing it needs search-response.ts, which is outside this slice. The stream_answer sibling named here previously — search-response.ts:25 assigning `envelope.notice = warning` (types.ts:812), a wire shape these fixtures do not emit — is NOT still open: it reads the same post-fence value, so it is now a whole contained region, pinned in tests/unit/server/search-response.test.ts. Fencing one field closed three sinks because all three read `data.warning` after fenceSearchData; only this one keeps a wigolo-authored prefix in front of the region, which is why only this one is still recorded.', closes: 'fence' },
  { path: 'search:$.brand_collision_warning.reason', note: 'NEW. Hostnames lifted from ENGINE-RETURNED result URLs are interpolated into wigolo own operator voice: core-provider.ts:914 -> detectSubjectCollision -> computeSubjectAnchorAttrition (subject-anchor.ts:219 hostOf(candidate.url)) -> brand-collision.ts:291 `the top slots went to ${sites.join(", ")}`. new URL().hostname bounds the charset, but the label is fully attacker-chosen — registering the domain is the whole attack — and it lands mid-sentence in text the agent reads as wigolo speaking. The result TITLE is only ever used as a predicate; the URL is the leak.', closes: 'fence' },
  { path: 'search:$.brand_collision_warning.brand_domains_in_top_3[]', note: 'NEW. The same origin-chosen hostnames as bare tokens (brand-collision.ts:257, :293). looksBrandy is a TLD-suffix REGEX — a filter, not a sanitizer — so the label left of the TLD is unconstrained. Milder than its `reason` sibling because it is not wrapped in wigolo prose, and it is the field the cheapest fix would move the hosts INTO, as fenced data.', closes: 'fence' },

  // ── DECLARED BUT DEAD. No producer in src/ assigns these; types.ts:1543 calls them
  //    "Stub-only marker". They are emitted by the fixtures only because gate 3 requires every
  //    DECLARED field to be exercised. An allowlist entry for a field that cannot carry bytes is
  //    vacuously true and worth nothing as evidence, so they are recorded rather than justified.
  { path: 'extract:structured:$.notice', note: 'NO PRODUCER. Swept both assignment forms repo-wide over src/: every `notice:` / `.notice =` hit is accounted for elsewhere (the fence envelope, the REPL watch path, the search notice, an openapi schema TYPE string).', closes: 'unreachable' },
  { path: 'extract:structured:$.slice', note: 'NO PRODUCER. Every `slice` hit in src/ is either a comment or a function parameter named slice; no property assignment exists.', closes: 'unreachable' },
  { path: 'diff:$.notice', note: 'NO PRODUCER. src/tools/diff.ts and src/cache/diff* contain no reference to the field.', closes: 'unreachable' },
  { path: 'diff:$.slice', note: 'NO PRODUCER, same sweep.', closes: 'unreachable' },
  { path: 'watch:$.notice', note: 'NO PRODUCER on the MCP path. The near-miss is repl/commands/watch.ts:100, which sets a module constant on the interactive SHELL output shape — a different type, not this response.', closes: 'unreachable' },
  { path: 'watch:$.slice', note: 'NO PRODUCER, same sweep.', closes: 'unreachable' },

  { path: 'compat:map:$.error', note: 'The compat surface, named OPEN in content-fence.ts:116. firecrawl-compat.ts:457 publishes mapResult.error as the envelope message from a DIRECT handleCrawl call that never passes through fenceCrawlData — the same origin-chosen Location text the native seams now contain. Deferred as its own change because that file carries the A11-R untrusted-mode decision and routing it through the shared fencer is a behaviour change on a compatibility surface, not a containment no-op. Its sibling site, handleCrawlStart settling a background job with crawl.error at :524, is the same channel on the polling route and is not walked here.', closes: 'fence' },
  // ── FOUND BY THIS INVARIANT, at 16ef68db. Each verdict is a traced producer, not an inference from
  //    a field name. The slice that FOUND them added no production code and recorded them all; a
  //    later slice CLOSED three — `watch:$.changes_since_last[].error`,
  //    `fetch:$.action_results[].error` and `search:$.images[].title` are fenced now and their records
  //    are gone, which is the graduation this register is supposed to produce. The rest are still
  //    live and still owe a fix.
  { path: 'search:$.engine_warnings[].message', note: 'NEW (one string, three fields — see the two below). engine-warnings.ts:117 copies EngineTelemetry.error, which is an engine adapter Error.message. Twelve adapters call response.json() with no try, so a 200 carrying a non-JSON body throws a V8 SyntaxError that QUOTES the body. sanitizeErrorMessage does NOT cover this path: engine-base.ts:230 has one caller, :569, and the response path at :620 is unsanitized and uncapped.', closes: 'fence' },
  { path: 'search:$.engine_telemetry[].error', note: 'NEW. The SAME EngineOutcome.error string one hop earlier (core-provider.ts:587). Fencing engine_warnings[].message alone would leave a bare copy of the identical bytes on the same envelope.', closes: 'fence' },
  { path: 'search:$.engine_outcomes[].error', note: 'NEW. The SAME string again (core-provider.ts:547), behind include_engine_outcomes:true. Lowest frequency, same bytes, same fix.', closes: 'fence' },
  { path: 'find_similar:$.error', note: 'NEW. find-similar.ts:351 returns `find_similar failed: ${err.message}` as a FindSimilarOutput, not an ok:false wrapper, so it never reaches a failure envelope. The pipeline it wraps runs router.fetch, and http-client.ts:271 throws `HTTP ${status} from ${currentUrl}` with currentUrl taken from an origin-chosen Location header.', closes: 'fence' },
  { path: 'search:$.results[].fetch_failed', note: 'NEW. Intended as a stage CODE and it is one on content-fetch.ts:233 — but reasonToFlag (content-fetch.ts:145) falls through to `reason.message` for any non-DOMException throw, so the same redirect-Location text reaches a field callers branch on as a flag.', closes: 'producer', shapeWhenClosed: 'machine-code' },
  { path: 'research:$.sources[].fetch_error', note: 'NEW. pipeline.ts:470 records the bare stage CODE on a refusal — deliberate and documented — but pipeline.ts:529 records a thrown Error.message on the other arm, which is the unbounded one.', closes: 'producer', shapeWhenClosed: 'machine-code' },
  { path: 'fetch:$.error', note: 'RECORDED, NOT LIVE. Declared on FetchOutput but no producer fills it on the MCP success path: the only assignment in the tree is the REPL envelope (src/repl/commands/fetch.ts:10), which never reaches fenceFetchData. It is emitted by the fixture because gate 3 requires every DECLARED field to be exercised, and it is recorded here rather than allowlisted because there is no construction to cite — the day a producer starts filling it, this note is what makes that visible instead of silent.', closes: 'unreachable' },
  { path: 'crawl:map:$.urls[]', note: 'REJECTED FROM THE ALLOWLIST, not merely unfenced. The justification offered was "URL-shaped by construction: mapper.ts:45 resolves through new URL(trimmed, origin) and same-origin filters". That is TRUE OF ONE OF TWO PRODUCERS. The sitemap <loc> branch (mapper.ts:100) does no resolution at all, and canonicalForOutput passes raw bytes through its catch — measured verbatim. A construction that covers one producer is exactly the defect this file exists to kill, so the entry was withdrawn rather than reworded.', closes: 'producer', shapeWhenClosed: 'absolute-http-url' },

  // ── Pinned already, elsewhere in the tree ────────────────────────────────────────────────────
  { path: 'agent:$.sources[].fetch_error', note: 'GAP-1 (unfenced-siblings.test.ts): fenceAgentData spreads ...data and does not enumerate AgentSource.fetch_error.', closes: 'fence' },
  { path: 'agent:$.error', note: 'GAP-2 (unfenced-siblings.test.ts): AgentOutput.error rides out on the success envelope unenumerated.', closes: 'fence' },
  { path: 'research:$.error', note: 'GAP-3 (unfenced-siblings.test.ts): ResearchOutput.error, same spread.', closes: 'fence' },
  { path: 'research:$.sub_queries[]', note: 'GAP-3 (unfenced-siblings.test.ts): ResearchOutput.sub_queries, same spread.', closes: 'fence' },
  { path: 'extract:structured:$.warnings[]', note: 'GAP-4 (unfenced-siblings.test.ts): ExtractOutput.warnings — the original A89 finding.', closes: 'fence' },
  { path: 'extract:structured:$.data.jsonld[]{key}', note: 'GAP-6a (unfenced-siblings.test.ts): a page-authored JSON-LD PROPERTY NAME is an unfenced key. Second site of the row-key class; still live.', closes: 'fence' },
  { path: 'fetch:$.site_data{key}', note: 'GAP-6b (unfenced-siblings.test.ts): nested site_data keys pass through fenceDeepValue unfenced.', closes: 'fence' },
  { path: 'fetch:$.site_data.nested{key}', note: 'GAP-6b (unfenced-siblings.test.ts): the same channel one level deeper.', closes: 'fence' },
  { path: 'search:$.error', note: 'Named OPEN in content-fence.ts:110 — the search_failed envelope publishes data.error and the MCP counterpart is not fenced either. Deferred as its own call, not an oversight.', closes: 'fence' },
  { path: 'search:rest-error:$.error', note: 'The REST half of the SearchOutput.error hole. content-fence.ts:110 names it: the search_failed envelope in dispatchSearch publishes data.error unfenced, and fencing one surface while the MCP counterpart stays raw would be a new asymmetry. Deferred as its own call.', closes: 'fence' },
];
