// Deliberately imports ONLY the wrapper. The marker constants are not imported here: reading a
// marker out of a payload is exactly the content-derived decision rule 1 forbids (see header).
import { wrapUntrusted } from '../security/untrusted.js';
import type {
  AgentOutput,
  CacheOutput,
  ChangeReport,
  Citation,
  CrawlOutput,
  DiffOutput,
  EvidenceItem,
  ExtractOutput,
  FetchOutput,
  FindSimilarOutput,
  Highlight,
  MapOutput,
  ResearchBrief,
  ResearchOutput,
  SearchOutput,
  TableData,
  WatchJobOutput,
} from '../types.js';

/** handleCrawl returns a crawl OR a map (mode='map', URL-list only, no page bodies). */
type CrawlResult = CrawlOutput | (MapOutput & { crawled: number });

/**
 * D7 — fence raw content-tool results returned to the AGENT in the [[UNTRUSTED DATA]] fence (the WIDE
 * boundary, symmetric to R1's synthesis-input fence). Applied at the MCP dispatch envelope ONLY (agent-
 * facing): the REPL/human path uses the handlers directly, and the research/agent pipelines gather via the
 * domain producers + fence at synthesis (R1) — neither reaches here. So the fence is WRAP-ONCE by placement
 * (no double-fence, no human-output pollution); see content-fence.test.ts PIN-A4.
 *
 * D7/A fences FLAT-MARKDOWN bodies (fetch/crawl/extract-as-string); D7/B fences the per-content fields of the
 * STRUCTURED returns (search/find_similar/extract-tables) while leaving operational fields (url/id/score) raw.
 *
 * P2: every wrap carries a FRESH per-call nonce and, where one is in scope, the source's ORIGIN — so a bulk
 * result gets one nonce per page (never a shared one across `pages[]`), and the reading model can see which
 * host each region came from. An origin is genuinely absent for html-input extracts and inline diffs; those
 * omit it rather than inventing a value.
 *
 * ── TWO RULES THIS FILE EXISTS TO ENFORCE (B1/B2 — read before adding an exemption) ──
 *
 * 1. NEVER decide whether to fence by inspecting the value. The values here are page-derived, so any
 *    content-derived predicate hands the attacker the control's decision input. This was shipped and
 *    caught: a `report.includes(<opening marker prefix>)` guard meant a page that merely PRINTED those
 *    characters disabled the fence for the whole report — forging nothing. Making the predicate
 *    stricter does not fix it; the payload is byte-exact, so a page can reproduce a full nonce-matched
 *    region verbatim. The only safe decision is no decision: fence unconditionally.
 *
 * 2. To make rule 1 possible, NO RESPONSE-BOUND PRODUCER MAY EMIT A FENCE. Fencing upstream is what
 *    forces the seam to ask "is this already fenced?" in the first place. Response producers
 *    (buildFallbackReport, buildFallbackSynthesis, research citation snippets) all emit plain text;
 *    this seam is the sole place a response-bound value is wrapped. PROMPT-bound producers are the
 *    opposite and keep their fences (buildUntrustedSourceBlocks, synthesis-local, answer-synthesis) —
 *    different sink, and nothing there flows into a response.
 *
 * Corollary, learned the hard way TWICE: an "already fenced upstream" exemption is only ever valid if
 * it holds for EVERY producer of that field, not the LLM one. Both times the exemption was written the
 * keyless producer wove raw page text straight in. Audit all producers, or do not exempt.
 */

/** Fence a page-derived string, attributing it to `origin` when one is in scope. */
function fence(value: string, origin?: string): string {
  return wrapUntrusted(value, origin !== undefined && origin !== '' ? { origin } : undefined);
}

/**
 * ── THE ERROR-SHAPE FENCE ───────────────────────────────────────────────────────────────────────
 *
 * Every other fencer in this file is typed on a SUCCESS shape, so the failure envelope — assembled by
 * hand at `stageErrorEnvelope` (src/server.ts) and `stageFailure` (src/daemon/rest/dispatch.ts) — had
 * no fence at all. It is not a theoretical gap: a producer builds its prose by interpolating bytes it
 * read off the wire (`src/tools/fetch.ts` splices the first 200 characters of a 4xx machine-typed
 * response body into its reason), and the assembly seam published that prose verbatim on the field an
 * agent reads as the human-readable message. Both the trigger (status + Content-Type + body) and the
 * bytes are origin-chosen, on the default keyless path, with no auth and no opt-in.
 *
 * WHY THE FIX IS HERE AND NOT AT THE PRODUCER. Trimming or sanitising one producer's snippet closes
 * one instance and leaves the class open — the next producer that interpolates origin text into a
 * reason re-opens it silently, with a green typecheck. Worse, a sanitiser is a control whose decision
 * input the origin writes. So the prose field is fenced UNCONDITIONALLY at the two assembly seams,
 * which is the whole population of hand-rolled failure envelopes: every future producer is contained
 * by construction and needs to remember nothing.
 *
 * Rule 1 of this module (above) applies unchanged: no branch on the value. The only structural check
 * is emptiness — an empty reason has nothing to contain, and emitting a full `(empty)` region for it
 * would be pure noise (same rationale as `fenceOptional`).
 *
 * WHAT MUST NOT BE FENCED, and why the two fields cannot be treated alike:
 *
 *  - the STABLE MACHINE CODE passes through BYTE-IDENTICAL. It is a closed vocabulary
 *    (`http_404`, `blocked_by_challenge`, `invalid_url`, …) pinned in three places at once —
 *    docs/rest-api.md's "Error shape", both SDKs (they read the published `error_reason` as the code),
 *    and `statusForStageResult`'s 502/503/400 tables. Fencing or rewriting it would break all three
 *    simultaneously, and it carries no origin bytes to contain: the producer authors it from a fixed
 *    vocabulary. Note this is the field the PUBLISHED envelope calls `error_reason` — the seams swap
 *    the two names on the way out, so read the doc comment at each seam before touching either.
 *  - `stage` is a wigolo-authored enum (`fetch` / `extract` / `validate` / …).
 *  - `hint` is operator guidance, authored at every producer in the tree: the literals in
 *    src/daemon/rest/errors.ts, `CODE_DESCRIPTIONS` in src/fetch/error-describe.ts:13, the ssrf
 *    literals in src/watch/ssrf.ts, src/tools/extract.ts:437, src/fetch/router.ts:1132, and
 *    `ChallengeBlockedError`'s constructor default (src/fetch/browser-pool.ts:165). No path
 *    interpolates response bytes into it, so fencing it would wrap ~350 characters of preamble around
 *    "Send a JSON object matching the tool input schema." for no gain. That premise is ONE caller
 *    away from being false — `ChallengeBlockedError` accepts a `hint` argument — so it is pinned by a
 *    tripwire rather than left tacit: tests/integration/error-envelope-fence.test.ts, TRIP-1.
 *
 * WHAT THIS DOES NOT COVER, named rather than implied away. The two seams are the whole population of
 * StageError assemblies. TWO other REST envelopes are hand-rolled from a non-StageError shape and are
 * deliberately left alone here — each is a separate call, not an oversight:
 *   - the `search_failed` envelope in `dispatchSearch` publishes search's in-band `data.error`, whose
 *     MCP counterpart ships on the SUCCESS envelope and is not fenced there either. Fencing one surface
 *     and not the other would be a new asymmetry.
 *   - `guardFailure` / the router's validation envelopes carry the CALLER's own input, never bytes read
 *     off a response.
 *
 * The firecrawl-compat surface was listed here as a THIRD, live and deferred rather than exempt. It is
 * now CLOSED: `src/daemon/rest/firecrawl-compat.ts` routes both of its sites — `mapResult.error` as the
 * map route's envelope message, and the `crawl.error` a polling client reads back off a settled job —
 * through this same `fenceErrorMessage`. The status is still classified from the UNFENCED producer
 * string, and the job store still holds byte-clean prose because the POLL is what fences, so nothing
 * persists a fence and every poll carries a fresh nonce.
 *
 * The deferral's stated reason does not survive being checked, which is the part worth keeping: it read
 * "that file carries the INVERSE untrusted-mode default by decision A11, so routing it through the
 * shared fencer is a behaviour change on a compatibility surface". A11 was REVERSED — the shim's own
 * header documents A11-R at length, and it takes the SAME fenced-by-default as the native routes. The
 * note it was drawn from (daemon/rest/dispatch.ts, at `withUntrustedEnvelope`) still says INVERSE and is
 * stale for the same reason; it is named here rather than silently corrected because it lives outside
 * this seam. Two lessons, both cheap: a deferral inherits the staleness of whatever it cites, and the
 * mode header governs SUCCESS payloads in the first place — error prose is fenced unconditionally on
 * the native seam, so matching it was never mode-dependent work.
 *
 * `crawlCacheFailure` (daemon/rest/dispatch.ts) was listed here as a third, on the rationale that it
 * "puts the SAME string in both fields, so fencing the prose half would leave a bare copy under the code
 * and buy nothing — closing it needs a code→message mapping that does not exist yet". Both halves of
 * that were FALSE, and the correction is recorded rather than quietly deleted because the shape of the
 * mistake is the reusable part: the two fields were never two representations of one value with a code
 * missing from the middle. `CrawlOutput.error` / `CacheOutput.error` carry PROSE at every producer site
 * in the tree (`handleCrawl`'s and `handleCache`'s catches emit `err.message`, the seed guard emits an
 * SsrfRejection's `reason`, `handleMapStrategy` emits `describeStageError`'s sentence, the clear path
 * emits an English instruction), so the value always WAS the message and the CODE was what was absent.
 * Nothing needed mapping: `codeForCrawlCacheError` reads it out of the same two constants
 * `statusForCrawlCacheError` already keyed its 400/502 rows on. That seam now fences its prose through
 * `fenceErrorMessage` like the other two, and the identical prose is fenced on the MCP SUCCESS envelope
 * by `fenceCrawlData` / `fenceCacheData` below.
 *
 * No origin is threaded. The producer shape carries a status and a stage but never the resolved URL,
 * and the seams would have to plumb it through ten dispatch arms to name one; the origin line is
 * informational ("which host is talking"), never load-bearing for containment, which comes from the
 * per-call nonce. Omitted rather than invented — same rule the html-input extract path follows.
 */
export function fenceErrorMessage(message: string): string {
  return typeof message === 'string' && message.length > 0 ? fence(message) : message;
}

/**
 * Fence an OPTIONAL page-derived field: absent, non-string, and empty values pass through unchanged.
 * Empty is skipped deliberately — several handlers blank a body on the way out (research clears
 * `markdown_content` unless include_full_markdown), and fencing '' would emit a full `(empty)` region
 * per source for no gain. A non-empty string is always fenced (fail-closed).
 */
function fenceOptional<T>(value: T, origin?: string): T | string {
  return typeof value === 'string' && value.length > 0 ? fence(value, origin) : value;
}

/** EvidenceItem: excerpt / title / section_heading are page-derived; url + ids + score + span are operational. */
function fenceEvidence(items: EvidenceItem[] | undefined, fallbackOrigin?: string): EvidenceItem[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((e) => {
    const origin = typeof e.url === 'string' && e.url !== '' ? e.url : fallbackOrigin;
    return {
      ...e,
      title: fenceOptional(e.title, origin) as string,
      excerpt: fenceOptional(e.excerpt, origin) as string,
      section_heading: fenceOptional(e.section_heading, origin) as string | null,
    };
  });
}

/** Highlight: text / source_title / section_heading are page-derived; source_url + indices are operational. */
function fenceHighlights(items: Highlight[] | undefined): Highlight[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((h) => ({
    ...h,
    text: fenceOptional(h.text, h.source_url) as string,
    source_title: fenceOptional(h.source_title, h.source_url) as string,
    section_heading: fenceOptional(h.section_heading, h.source_url) as string | null | undefined,
  }));
}

/**
 * Citation titles + snippets — both always fenced here.
 *
 * F1: this used to take a `snippetAlreadyFenced` flag, passed `true` for research because
 * research/synthesize.ts fenced its snippets upstream. That was fail-OPEN: research has TWO citation
 * producers, and the local-LLM path (research/pipeline.ts, reached via WIGOLO_LOCAL_LLM or any
 * provider routing through synthesizeLocal) rebuilds the array with a raw
 * `stripResearchChrome(...).slice(0, 200)` snippet. The flag skipped it, so a hostile snippet shipped
 * bare beside its own fenced `title`. The producer-side fence is gone and the seam now fences
 * unconditionally: one invariant at one choke point, rather than an assumption every future producer
 * must remember.
 */
function fenceCitations(items: Citation[] | undefined): Citation[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((c) => ({
    ...c,
    title: fenceOptional(c.title, c.url) as string,
    snippet: fenceOptional(c.snippet, c.url) as string,
  }));
}

export function fenceFetchData(data: FetchOutput): FetchOutput {
  const origin = data.url;
  const out: FetchOutput = {
    ...data,
    ...(typeof data.markdown === 'string' ? { markdown: fence(data.markdown, origin) } : {}),
    // `document.title` and the meta description are fully attacker-controlled and were returned raw.
    title: fenceOptional(data.title, origin) as string,
    // F4: hand-picking `description` left og_type / date / keywords raw, while the extract seam's own
    // OPERATIONAL_KEYS comment declares those exact keys fail-CLOSED. Same keys, two policies. Route
    // metadata through the same deep-fence so there is one policy; canonical_url and og_image are on
    // the allowlist and stay raw for free.
    ...(data.metadata && typeof data.metadata === 'object'
      ? { metadata: fenceDeepValue(data.metadata, false, 0, origin) as FetchOutput['metadata'] }
      : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence, origin) } : {}),
    // site_data is per-site JSON lifted straight off the page (Reddit/YouTube/Amazon) — deep-fence its
    // string leaves with the same operational-key allowlist the extract seam uses.
    ...(data.site_data && typeof data.site_data === 'object'
      ? { site_data: fenceDeepValue(data.site_data, false, 0, origin) as Record<string, unknown> }
      : {}),
    // F2: a browser ACTION's failure text, on the SUCCESS envelope. `src/fetch/action-executor.ts`
    // assigns a caught `Error.message`, and the `scroll` action runs `page.evaluate` INSIDE the
    // document — so a page that redefines `window.scrollBy` to throw has its OWN exception message
    // rethrown in Node and published verbatim: unbounded, arbitrary charset, origin-chosen. This
    // array was reached by the `...data` spread and never enumerated, so it shipped bare beside the
    // fenced markdown of the very page that wrote it.
    //
    // The two siblings stay RAW for reasons that do not generalise to `error`: `type` is the action
    // the CALLER asked for, echoed back out of its own input (a closed six-member vocabulary the
    // caller matches on), and `screenshot` is a base64 capture, not a text channel. `action_index`
    // and `success` are not strings.
    ...(Array.isArray(data.action_results)
      ? {
          action_results: data.action_results.map((a) => ({
            ...a,
            ...(typeof a.error === 'string' && a.error.length > 0 ? { error: fence(a.error, origin) } : {}),
          })),
        }
      : {}),
  };
  return out;
}

/**
 * The IN-BAND `error` field of a crawl/cache result — page-derived prose on a SUCCESS envelope.
 *
 * `CrawlOutput.error` / `MapOutput.error` / `CacheOutput.error` / `ChangeReport.error` are the failure
 * channel of tools that report their failures IN BAND: `server.ts` derives `isError` from them but still
 * ships the whole `data` object, so these strings never pass through `stageErrorEnvelope` and were left
 * raw here. (`SearchOutput.error` is the SAME shape and is still raw on both surfaces — see the header's
 * `search_failed` bullet; it is a separate call, not covered by this.) Measured live: `handleMapStrategy`'s fetch shim
 * throws `describeStageError(raw)`, `describeFetchError` passes a generic error's `.message` through
 * verbatim, and `http-client.ts` throws ``HTTP ${status} from ${currentUrl}`` where `currentUrl` came out
 * of an origin-chosen `Location:` header — so an origin authors the path and query of that URL and they
 * arrive here byte-for-byte (WHATWG normalisation strips CR/LF/TAB and percent-encodes NUL/ESC/<>"/space,
 * but `:`, `;`, `_`, backtick and alphanumerics survive, bounded only by the 16 KiB header block).
 *
 * Fenced UNCONDITIONALLY, per rule 1: a wigolo-authored refusal (the SSRF seed guard's reason, the clear
 * path's instruction) is wrapped too. Over-fencing a failure message fails safe and costs a preamble;
 * asking "is this one page-derived?" would hand the origin the control's decision input. The only
 * structural check is emptiness, exactly as `fenceErrorMessage` and `fenceOptional` do.
 *
 * NOT fenced, and they are the reason this is a per-field spread rather than a deep fence:
 * `ChangeReport.diff_summary` is wigolo-authored line COUNTS (`computeDiffSummary` interpolates only
 * numbers — no page bytes reach it), `current_hash` / `previous_hash` are digests, `url` is dereferenced,
 * and `MapOutput.urls` is the tool's whole answer. Wrapping any of them would break a consumer to
 * contain nothing.
 */
function fencedInBandError(error: string | undefined): { error?: string } {
  return typeof error === 'string' && error.length > 0 ? { error: fenceErrorMessage(error) } : {};
}

export function fenceCrawlData(data: CrawlResult): CrawlResult {
  // mode='map' returns URLs only (no `pages`) — but it DOES carry `error`, which is where the
  // origin-chosen redirect target arrives. This early return used to skip that field entirely.
  if (!('pages' in data) || !Array.isArray(data.pages)) {
    return { ...data, ...fencedInBandError(data.error) };
  }
  return {
    ...data,
    ...fencedInBandError(data.error),
    // One FRESH nonce per page — never shared across `pages[]`, or one page's close marker would
    // terminate another page's region.
    pages: data.pages.map((p) => ({
      ...p,
      ...(typeof p.markdown === 'string' ? { markdown: fence(p.markdown, p.url) } : {}),
      title: fenceOptional(p.title, p.url) as string,
      ...(p.excerpt !== undefined ? { excerpt: fenceOptional(p.excerpt, p.url) as string } : {}),
      ...(p.evidence ? { evidence: fenceEvidence(p.evidence, p.url) } : {}),
    })),
  };
}

/**
 * F7 — table row KEYS were page prose shipped RAW.
 *
 * `TableData.rows` is keyed by the table's own `<th>` text (src/extraction/extract.ts:374 does
 * `obj[header] = cell`). Fencing only the VALUES therefore shipped the identical page-authored
 * string twice on the `isError: false` success envelope: fenced inside `headers[]`, and BARE as the
 * object key beside its own fenced cell — once per row, so an N-row table repeated it N times.
 * Unlike the narrow channels elsewhere in this file it was arbitrary prose of arbitrary length
 * (measured: a 5000-char header, embedded marker syntax, and raw NUL/ESC all survived verbatim),
 * reachable through `extract mode:"tables"` and `mode:"structured"` with no LLM key involved.
 *
 * The key cannot be fenced IN PLACE — a 300-character wrapped blob is not dereferenceable, and it
 * would still be prose. It also cannot merely be SANITISED: the threat here is the prose itself
 * reaching the agent unfenced, not marker forgery, so `neutralizeMarkers` (the studio structured-JSON
 * remedy, which is paired with an instruction-channel notice) would leave "ignore your instructions"
 * fully intact. The only fix that closes the channel is for page text to stop being a key at all.
 *
 * So the key is replaced by a WIGOLO-AUTHORED positional handle, `col_1..col_N`, aligned by INDEX to
 * the already-fenced `headers[]` — the label is not lost, it is read from `headers[i]`, where it is
 * contained. `col_N` is not new vocabulary: it is already what the extractor synthesises for a table
 * with no `<th>` at all (extract.ts:325), so the two cases now agree instead of diverging.
 *
 * Alignment is to the HEADER index, never to the row's own entry order: three of the four producers
 * (segmentInterleavedListing, div-grid buildTable, list.ts) emit SPARSE rows against a unioned header
 * set, so entry-order numbering would slide `col_2` onto a different column from one row to the next.
 * Absent headers are omitted rather than back-filled, which preserves that sparsity exactly as today.
 *
 * This runs at the MCP dispatch envelope ONLY (see module header), so it does not touch the REPL
 * formatter's `row[h]` render, `extraction/schema.ts`'s header→property matching, or the REST path —
 * all three read the producer's shape upstream of this seam.
 */
function fenceRow(row: Record<string, string>, headers: string[], origin?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const consumed = new Set<string>();
  headers.forEach((header, i) => {
    if (!Object.prototype.hasOwnProperty.call(row, header)) return;
    consumed.add(header);
    const v = row[header];
    out[`col_${i + 1}`] = typeof v === 'string' ? fence(v, origin) : v;
  });
  // A row key with no header slot is still page data, so it is APPENDED rather than dropped — this
  // seam must never lose a cell to close a hole. Today's producers cannot reach it (every one keys
  // rows from the same header list it returns); it exists so a future producer cannot silently
  // delete content by drifting from that contract.
  let extra = headers.length;
  for (const [k, v] of Object.entries(row)) {
    if (consumed.has(k)) continue;
    extra += 1;
    out[`col_${extra}`] = typeof v === 'string' ? fence(v, origin) : v;
  }
  return out;
}

function fenceTable(t: TableData, origin?: string): TableData {
  const headers = Array.isArray(t.headers) ? t.headers : [];
  return {
    ...t,
    ...(typeof t.caption === 'string' ? { caption: fence(t.caption, origin) } : {}),
    headers: Array.isArray(t.headers) ? t.headers.map((h) => fence(h, origin)) : t.headers,
    rows: Array.isArray(t.rows) ? t.rows.map((row) => fenceRow(row, headers, origin)) : t.rows,
  };
}

/**
 * Table-shaped enough for `fenceTable` to key its rows positionally. Used ONLY to pick BETWEEN two
 * fencing strategies on the structured path — never to decide WHETHER to fence (rule 1 above). The
 * alternative branch is the deep fence, which wraps every string leaf regardless, so a value that
 * fails this check is not left barer than it is today.
 */
function isTableShape(v: unknown): v is TableData {
  return (
    v !== null && typeof v === 'object' && Array.isArray((v as TableData).headers) && Array.isArray((v as TableData).rows)
  );
}

// D16: keys whose string values are OPERATIONAL (URLs/URIs/identity the agent dereferences or matches by) —
// kept RAW so the agent can still act on them. Everything else fails CLOSED (fenced). Grounded in the extract
// type shapes (MetadataData canonical_url / og_image) + schema.org json-ld conventions (@id/@type/@context/
// url/sameAs/contentUrl/embedUrl/...). Matched case-insensitively. Ambiguous or page-classifier keys
// (source / og_type / type_hint / date / keywords) are deliberately NOT operational → fail-closed (fenced).
const OPERATIONAL_KEYS = new Set<string>([
  'url', 'href', '@id', '@type', '@context', 'identifier', 'sameas',
  'contenturl', 'embedurl', 'thumbnailurl', 'image', 'logo',
  'mainentityofpage', 'target', 'additionaltype', 'canonical_url', 'og_image',
]);

// Bound the descent into nested objects/arrays (cyclic-ref / pathological-nesting guard). Real extract objects
// are shallow; the bound only stops runaway descent — string leaves are fenced regardless of depth (below).
const MAX_FENCE_DEPTH = 16;

/**
 * Exported ONLY so the envelope-wide containment guard can ask this module's own allowlist in this
 * module's own words. The alternative was a second copy of OPERATIONAL_KEYS in the test tree, which
 * would drift silently the first time a key is added here. No behaviour change — the set and the
 * lookup are untouched.
 */
export function isOperationalKey(key: string): boolean {
  return OPERATIONAL_KEYS.has(key.toLowerCase());
}

/**
 * D16: recursively fence the string leaves of a deep extract value. `rawLeaf` carries the parent key's
 * operational-ness onto string + array leaves (so `sameAs: [url, url]` stays raw); objects decide per-key.
 * String leaves are ALWAYS handled (fenced unless operational) regardless of depth — only the DESCENT into
 * nested objects/arrays is depth-bounded, so a cycle can't run away yet content is never left unfenced by the
 * bound. Object shape is rebuilt key-for-key (no flatten). Non-string scalars are not an injection vector.
 */
function fenceDeepValue(value: unknown, rawLeaf: boolean, depth: number, origin?: string): unknown {
  if (typeof value === 'string') return rawLeaf ? value : fence(value, origin);
  if (depth >= MAX_FENCE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => fenceDeepValue(v, rawLeaf, depth + 1, origin));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fenceDeepValue(v, isOperationalKey(k), depth + 1, origin);
    return out;
  }
  return value;
}

export function fenceExtractData(data: ExtractOutput): ExtractOutput {
  // `source_url` is OPTIONAL — absent for html-input extracts, where there is no origin to name.
  const origin = data.source_url;
  // D7/A flat string; D7/B structured ARRAYS (string[] selector-multi, TableData[] tables) — per-content-field.
  if (typeof data.data === 'string') {
    return { ...data, data: fence(data.data, origin) };
  }
  if (Array.isArray(data.data)) {
    const fenced = data.data.map((item) => (typeof item === 'string' ? fence(item, origin) : fenceTable(item as TableData, origin)));
    return { ...data, data: fenced as ExtractOutput['data'] };
  }
  // D16: deep object shapes (MetadataData / StructuredData / arbitrary json-ld Records) — recursively fence
  // string leaves except under a known-operational key; UNKNOWN keys fail CLOSED (fenced). Shape preserved.
  //
  // F7: `mode:'structured'` reaches its tables THROUGH this branch, not through the array branch above, so
  // fixing only `fenceTable` would have closed the row-key hole for `mode:'tables'` and left it wide open on
  // `mode:'structured'` — the same defect at a second, equally keyless entry point (measured before the fix:
  // a `<th>` canary shipped bare as a row key on BOTH modes). The loop below mirrors fenceDeepValue's own
  // object case exactly — same per-key operational test, same child depth, same key order — and diverges only
  // to route StructuredData.tables through fenceTable.
  if (data.data !== null && typeof data.data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data.data as Record<string, unknown>)) {
      out[k] =
        k === 'tables' && Array.isArray(v)
          ? v.map((t) => (isTableShape(t) ? fenceTable(t, origin) : fenceDeepValue(t, false, 1, origin)))
          : fenceDeepValue(v, isOperationalKey(k), 1, origin);
    }
    return { ...data, data: out as ExtractOutput['data'] };
  }
  return data;
}

export function fenceFindSimilarData(data: FindSimilarOutput): FindSimilarOutput {
  return {
    ...data,
    ...(Array.isArray(data.results)
      ? {
          results: data.results.map((r) => ({
            ...r,
            title: typeof r.title === 'string' ? fence(r.title, r.url) : r.title,
            markdown: typeof r.markdown === 'string' ? fence(r.markdown, r.url) : r.markdown,
          })),
        }
      : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
  };
}

export function fenceSearchData(data: SearchOutput): SearchOutput {
  return {
    ...data,
    ...(Array.isArray(data.results)
      ? {
          results: data.results.map((r) => ({
            ...r,
            title: typeof r.title === 'string' ? fence(r.title, r.url) : r.title,
            snippet: typeof r.snippet === 'string' ? fence(r.snippet, r.url) : r.snippet,
            ...(typeof r.markdown_content === 'string' ? { markdown_content: fence(r.markdown_content, r.url) } : {}),
            // F5: alt text is page prose the author controls, same as a title. image_url stays raw.
            ...(r.image_alt !== undefined ? { image_alt: fenceOptional(r.image_alt, r.url) as string } : {}),
          })),
        }
      : {}),
    // F5: the aggregated top-level image list carries the same alt prose; url/source_url stay raw.
    //
    // F3 — and `title` beside it, which fencing `alt` alone did NOT cover. That gap looked like a
    // duplicate-field question and was not: `ImageItem` declares both, but NEITHER image adapter
    // fills `alt` (src/search/engines/ddg-image.ts, brave-image.ts both set
    // `title: item.title || item.source || image` and no alt at all), so on the engines that produce
    // this array `title` is not a second copy of a fenced sibling — it is the ONLY copy of the
    // engine-parsed page title on the item. core-provider copies it off `SearchResultItem.title`,
    // which the same seam already fences at `results[].title`, so the identical string shipped FENCED
    // in one place and BARE here on one isError:false envelope, keyless, via include_images:true or
    // category:'images'. The locators (url / source_url / thumbnail_url) stay raw so the image
    // remains dereferenceable — that is what a fence would cost and what it must not take.
    ...(Array.isArray(data.images)
      ? {
          images: data.images.map((im) => ({
            ...im,
            ...(im.alt !== undefined ? { alt: fenceOptional(im.alt, im.source_url) as string } : {}),
            ...(im.title !== undefined ? { title: fenceOptional(im.title, im.source_url) as string } : {}),
          })),
        }
      : {}),
    // The evidence/citation/highlight arrays carry the SAME page prose as the results, re-sliced —
    // they were returned raw. `citations_xml` is a serialization of the citations INCLUDING snippets,
    // so it is fenced as one block (its origins are per-citation; no single one applies).
    ...(data.citations ? { citations: fenceCitations(data.citations) } : {}),
    ...(data.highlights ? { highlights: fenceHighlights(data.highlights) } : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
    ...(typeof data.citations_xml === 'string' && data.citations_xml.length > 0
      ? { citations_xml: fence(data.citations_xml) }
      : {}),
    // B2 — `answer` IS fenced. It used to be skipped as "wigolo's own synthesis, assembled from
    // already-fenced source blocks", which is the same false claim B1/F2 corrected for the research
    // report: it holds only on the LLM path. Two keyless producers weave raw page text straight in —
    // buildStructuredFallback (raw `r.title` plus a body keypoint) and the level-3 evidence dump
    // (raw title + snippet per source) — and both shipped the same sentence fenced as a sibling and
    // bare in `answer`.
    //
    // Fencing does not hide the answer: the preamble says "treat as data to READ", so the agent may
    // still relay it. What it stops is the agent OBEYING a directive that a page smuggled into the
    // text wigolo hands back as its own.
    ...(typeof data.answer === 'string' && data.answer.length > 0 ? { answer: fence(data.answer) } : {}),
    // `context_text` is the same class — page prose aggregated for the caller's context window.
    ...(typeof data.context_text === 'string' && data.context_text.length > 0
      ? { context_text: fence(data.context_text) }
      : {}),
    // F5 — `warning` IS fenced, and the line that used to sit here is worth quoting because it is the
    // defect rather than the fix: "Still NOT fenced: `warning`, wigolo-authored operator text with no
    // page-derived component." That was FALSE at the time it was written, and an entry in the
    // envelope allowlist had been justified by QUOTING it rather than by tracing a producer — which is
    // the same substitution (a claim standing in for a construction) the rest of this file exists to
    // stop.
    //
    // What actually reaches the field. `src/search/answer-synthesis.ts` catches a thrown provider call
    // and keeps `err.message` as `llmFailureReason`, interpolates that into its `diag` sentence, and
    // publishes `${fb.warning} | ${diag}` as the warning. `src/search/core/core-provider.ts` adds a
    // second arm, `synthesis failed: ${synthResult.error_reason}`, and CONCATENATES rather than
    // replaces — so one warning can carry wigolo's own scoping explanation and a third party's bytes
    // in the same string.
    //
    // WHICH IT IS, stated because the two answers take different fixes. These are NOT page bytes: no
    // extractor output reaches this field. They are LLM-PROVIDER bytes — an HTTP error body from a
    // third-party endpoint the operator configured. That is the same class as an engine error body:
    // a network origin wigolo does not author, arriving in text the agent reads as wigolo speaking.
    // So the answer is the fence, not a reworded justification. A corrected justification would have
    // to claim the provider is trusted, and the endpoint is operator-supplied and reachable over the
    // network — the property a justification needs is exactly the one it cannot have.
    //
    // Rule 1 applies unchanged: no branch on the value. Asking "is THIS warning the wigolo half or the
    // provider half" is impossible anyway once the two are concatenated, and it would hand the
    // decision input to whoever wrote the second half. Over-fencing operator guidance costs a preamble
    // and reads fine — the fence says "treat as data to READ", so the agent may still relay it.
    ...(typeof data.warning === 'string' && data.warning.length > 0 ? { warning: fence(data.warning) } : {}),
  };
}

/**
 * A `ChangeReport`'s in-band `error` — ONE fencer, because ONE shape is emitted by TWO tools.
 *
 * `cache` (check_changes) and `watch` (action:'check') both return this array, and both fill the
 * field from the SAME producer: a refused re-fetch, whose reason carries bytes read off the wire.
 * They were closed at different times and, while `cache`'s arm was a private copy inside
 * `fenceCacheData`, `watch` had no fencer at all — so the two surfaces disagreed about the identical
 * shape. Sharing the function is what makes that class of disagreement unrepresentable rather than
 * merely fixed: a third producer of a ChangeReport inherits the containment instead of having to
 * remember it.
 *
 * A ChangeReport names its own url, so the region is ATTRIBUTED — unlike the top-level `error`,
 * where the seams carry no resolved URL. NOT fenced, and the reason they cannot be lumped in:
 * `diff_summary` is wigolo-authored line COUNTS (computeDiffSummary interpolates only numbers),
 * `current_hash` / `previous_hash` are digests a change detector compares, `changed` is a boolean,
 * and `url` is dereferenced. Wrapping any of them would break a consumer to contain nothing.
 */
function fenceChangeReports(reports: ChangeReport[]): ChangeReport[] {
  return reports.map((c) => ({
    ...c,
    ...(typeof c.error === 'string' && c.error.length > 0 ? { error: fence(c.error, c.url) } : {}),
  }));
}

/**
 * `cache` returns stored page bodies and titles from `url_cache` unioned with `studio_artifacts`.
 * It was UNFENCED, which also made it the open path for artifact rows (see decision A2b). `url` and
 * `trusted` stay raw — the agent dereferences one and must see the other.
 *
 * The `!Array.isArray(data.results)` early return this used to open with skipped EVERY other shape the
 * tool can return — `error` and, more sharply, `changes[].error`, which `handleCache`'s check_changes
 * loop fills from `describeStageError(raw)` on a refused re-fetch. That is the same origin-chosen
 * redirect text `fencedInBandError` describes, arriving on a success envelope by a second route. Each
 * arm is now an independent spread so no shape can be skipped by another's absence.
 */
export function fenceCacheData(data: CacheOutput): CacheOutput {
  return {
    ...data,
    ...fencedInBandError(data.error),
    ...(Array.isArray(data.results)
      ? {
          results: data.results.map((r) => ({
            ...r,
            title: fenceOptional(r.title, r.url) as string,
            markdown: fenceOptional(r.markdown, r.url) as string,
          })),
        }
      : {}),
    ...(Array.isArray(data.changes) ? { changes: fenceChangeReports(data.changes) } : {}),
  };
}

/**
 * `watch` — the tool that had NO fencer on EITHER surface.
 *
 * `src/server.ts` returned `r.data` verbatim and `watch` was absent from `PAGE_DERIVED_TOOLS`, so the
 * REST dispatcher skipped it for a second, independent reason. The justification on record was that
 * watch "returns content hashes and coarse line counts, not page prose". That is true of every field
 * BUT ONE, and the exception is the whole tool's failure channel: `src/watch/scheduler.ts` sets
 * `report.error` from `fetched.error_reason ?? fetched.error`, and the producer orientation makes the
 * `??` select the PROSE — `src/tools/fetch.ts` splices the first 200 characters of a machine-typed 4xx
 * response body into `error_reason` while `error` holds the machine code. Those are the exact bytes
 * `fenceErrorMessage` exists to contain, arriving by a route that touches NEITHER assembly seam,
 * because watch reports its failure IN BAND on an ok:true envelope. A second arm (the scheduler's
 * catch) adds a thrown `Error.message` on the same field.
 *
 * Everything else on `WatchJobOutput` is deliberately untouched, and the list is short enough to
 * state rather than imply: `jobs[]` / `job` carry an id the agent passes back to `action:'check'`, a
 * dereferenced url, a caller-authored selector and notification target, a status enum, and epoch
 * numbers. Fencing an id would make the tool unusable to contain nothing.
 */
export function fenceWatchData(data: WatchJobOutput): WatchJobOutput {
  return {
    ...data,
    ...(Array.isArray(data.changes_since_last)
      ? { changes_since_last: fenceChangeReports(data.changes_since_last) }
      : {}),
  };
}

/** ResearchBrief string leaves. No single origin applies — the brief is synthesized ACROSS sources. */
function fenceBrief(brief: ResearchBrief): ResearchBrief {
  const sections = brief.sections;
  return {
    ...brief,
    topics: Array.isArray(brief.topics) ? brief.topics.map((t) => fenceOptional(t) as string) : brief.topics,
    key_findings: Array.isArray(brief.key_findings) ? brief.key_findings.map((k) => fenceOptional(k) as string) : brief.key_findings,
    ...(brief.highlights ? { highlights: fenceHighlights(brief.highlights) as Highlight[] } : {}),
    ...(brief.citation_graph
      ? { citation_graph: brief.citation_graph.map((c) => ({ ...c, claim: fenceOptional(c.claim) as string })) }
      : {}),
    ...(sections && typeof sections === 'object'
      ? {
          sections: {
            ...sections,
            overview: {
              ...sections.overview,
              key_findings: Array.isArray(sections.overview?.key_findings)
                ? sections.overview.key_findings.map((k) => fenceOptional(k) as string)
                : sections.overview?.key_findings,
              cross_references: Array.isArray(sections.overview?.cross_references)
                ? sections.overview.cross_references.map((x) => ({ ...x, finding: fenceOptional(x.finding) as string }))
                : sections.overview?.cross_references,
            },
            ...(sections.comparison
              ? {
                  comparison: {
                    ...sections.comparison,
                    entities: sections.comparison.entities?.map((e) => fenceOptional(e) as string),
                    comparison_points: sections.comparison.comparison_points?.map((c) => fenceOptional(c) as string),
                    tradeoffs: sections.comparison.tradeoffs?.map((t) => ({
                      ...t,
                      text: fenceOptional(t.text) as string,
                      term: fenceOptional(t.term) as string,
                    })),
                  },
                }
              : {}),
            gaps: Array.isArray(sections.gaps)
              ? sections.gaps.map((g) => (typeof g === 'string' ? (fenceOptional(g) as string) : { ...g, reason: fenceOptional(g.reason) as string }))
              : sections.gaps,
          },
        }
      : {}),
  };
}

/**
 * `research` was UNFENCED at the dispatch envelope even though its sources, evidence and brief carry
 * page prose verbatim.
 *
 * B1 — `report` is fenced UNCONDITIONALLY. The previous attempt inspected the value
 * (an `includes(<opening marker prefix>)` test) to avoid double-wrapping the one producer that emitted
 * fences. That was a control whose decision input the attacker writes: `renderBriefReport` weaves raw
 * page sentences into the report, so a page that merely PRINTED those 29 characters switched the
 * fence off for the entire report — no nonce, no terminator, no forgery of any kind required. A
 * stronger predicate would not have saved it either: the payload is byte-exact, so a page can emit a
 * complete nonce-matched region verbatim.
 *
 * The decision is therefore deleted rather than hardened. `buildFallbackReport` no longer fences its
 * source bodies, so NO response-bound producer emits a fence, so the seam never has to ask. See the
 * module header: response producers stay fence-free; prompt producers keep theirs.
 */
export function fenceResearchData(data: ResearchOutput): ResearchOutput {
  return {
    ...data,
    ...(typeof data.report === 'string' && data.report.length > 0 ? { report: fence(data.report) } : {}),
    ...(Array.isArray(data.sources)
      ? {
          sources: data.sources.map((s) => ({
            ...s,
            title: fenceOptional(s.title, s.url) as string,
            markdown_content: fenceOptional(s.markdown_content, s.url) as string,
          })),
        }
      : {}),
    ...(data.citations ? { citations: fenceCitations(data.citations) as Citation[] } : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
    ...(data.brief ? { brief: fenceBrief(data.brief) } : {}),
  };
}

/**
 * `agent` was UNFENCED across its per-source markdown, titles and step log.
 *
 * `rawHtml` is fenced too, but as defence in depth rather than a live hole: `stripRawHtml`
 * (src/agent/pipeline.ts) deletes the field on every return path of runAgentPipeline, so it does not
 * reach a caller today. The field is still declared optional on AgentSource, so the fence is here to
 * fail CLOSED if that strip is ever relaxed or an AgentOutput is assembled by another producer.
 *
 * B1 — `result` is fenced in BOTH shapes, unconditionally. The string form used to be skipped as
 * "already fence-bearing", which is the same defect as the research report: `buildFallbackSynthesis`
 * is only one of its producers, and leaving it fence-bearing forced a content-derived decision the
 * page could flip. That producer no longer fences, so the string is simply wrapped; the Record form
 * (schema path, page-extracted, never fenced upstream) is deep-fenced as before.
 */
export function fenceAgentData(data: AgentOutput): AgentOutput {
  return {
    ...data,
    ...(data.result !== null && typeof data.result === 'object'
      ? { result: fenceDeepValue(data.result, false, 0) as Record<string, unknown> }
      : typeof data.result === 'string' && data.result.length > 0
        ? { result: fence(data.result) }
        : {}),
    ...(Array.isArray(data.sources)
      ? {
          sources: data.sources.map((s) => ({
            ...s,
            title: fenceOptional(s.title, s.url) as string,
            markdown_content: fenceOptional(s.markdown_content, s.url) as string,
            ...(s.rawHtml !== undefined ? { rawHtml: fenceOptional(s.rawHtml, s.url) as string } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(data.steps)
      ? { steps: data.steps.map((s) => ({ ...s, detail: fenceOptional(s.detail) as string })) }
      : {}),
    ...(data.evidence ? { evidence: fenceEvidence(data.evidence) } : {}),
  };
}

/**
 * `diff` returns verbatim page text on BOTH sides and was unfenced. `DiffOutput` carries no url, so
 * the origin comes from the caller's input when it named one; a diff of two inline markdown blobs has
 * no origin at all and omits it rather than inventing one. `notice` / `slice` are wigolo-authored.
 */
export function fenceDiffData(data: DiffOutput, origin?: string): DiffOutput {
  return {
    ...data,
    ...(typeof data.unified_diff === 'string' && data.unified_diff.length > 0
      ? { unified_diff: fence(data.unified_diff, origin) }
      : {}),
    ...(Array.isArray(data.hunks)
      ? {
          hunks: data.hunks.map((h) => ({
            ...h,
            before: fenceOptional(h.before, origin) as string,
            after: fenceOptional(h.after, origin) as string,
            ...(h.section_title !== undefined ? { section_title: fenceOptional(h.section_title, origin) as string } : {}),
          })),
        }
      : {}),
  };
}

/** Best-effort origin for a diff: whichever side named a url. Neither side is required to. */
export function diffOriginFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['new', 'old']) {
    const side = input[key];
    if (side !== null && typeof side === 'object') {
      const url = (side as { url?: unknown }).url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  return undefined;
}
