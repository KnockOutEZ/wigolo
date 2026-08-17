import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer, type Subsystems } from '../../src/server.js';
import { SmartRouter, type HttpClient } from '../../src/fetch/router.js';
import { httpFetch } from '../../src/fetch/http-client.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';
import { resetConfig } from '../../src/config.js';
import { findUnfencedInEnvelope } from '../helpers/envelope-fence.js';
import {
  UNTRUSTED_BEGIN_PREFIX,
  UNTRUSTED_END_PREFIX,
  UNTRUSTED_NONCE_HEX_LENGTH,
} from '../../src/security/untrusted.js';
import type {
  CacheOutput, CrawlOutput, ExtractionResult, MapOutput, RawFetchResult, StageError,
} from '../../src/types.js';

/**
 * THE CRAWL/CACHE **SUCCESS** ENVELOPE IS FENCED — the MCP half of the channel
 * `error-envelope-fence.test.ts` closed on REST.
 *
 * Crawl and cache report failure IN BAND: `src/server.ts` derives `isError` from `data.error` but still
 * serialises the whole result object, so those strings never reach `stageErrorEnvelope`. `fenceCrawlData`
 * early-returned for `mode:'map'` (no `pages` key) and neither branch touched `error`; `fenceCacheData`
 * early-returned whenever `results` was absent, which is every check_changes and every failure. So the
 * REST surface contained this text and the MCP surface published it bare — the asymmetry that
 * `content-fence.ts`'s header exists to forbid.
 *
 * WHY THE PAYLOAD LOOKS LIKE THIS. The channel is an origin-chosen `Location:` header. `http-client.ts`
 * resolves it with `new URL(location, currentUrl)` and, on a 429/502/503, throws
 * ``HTTP ${status} from ${currentUrl}``; `router.fetch`'s `renderJs:'never'` arm has no try/catch, so it
 * escapes verbatim into `mapUrls`' `String(err)` and out as `MapOutput.error`. WHATWG normalisation
 * bounds what survives — CR/LF/TAB are stripped and NUL/ESC/`<`/`>`/`"`/space are percent-encoded — but
 * `:`, `;`, `_`, backtick and alphanumerics pass through a query string byte-for-byte, which is a
 * sufficient alphabet for a directive sentence, at up to the 16 KiB header block. The canary below is
 * built from exactly that surviving set and is served through a real `Response` `location` header, not
 * hand-typed into a fixture, so a change at the throw site is visible here (see FORMAT-1).
 */

const SEED = 'https://ok.example/';
/** Only characters MEASURED to survive `new URL()` inside a query string. No English directive needed —
 *  the point under test is the alphabet and the length, not any particular sentence. */
const CANARY = 'MCPFENCE7c1e:alpha;beta_gamma`delta`';
const HOSTILE_LOCATION = `https://redirected.example/p?x=${CANARY}`;
/** The exact bytes `http-client.ts` interpolates. Asserted, not assumed — FORMAT-1. */
const THROW_FORMAT = `HTTP 503 from ${HOSTILE_LOCATION}`;

/**
 * A hostile origin, expressed only in things it can actually put on the wire: a 302 with a `Location`
 * header, then a 503 at the target it chose. robots.txt/sitemap.xml answer so map's discovery phase
 * completes and the SEED is the hop that fails — the one URL whose failure becomes `MapOutput.error`.
 */
function hostileFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === `${SEED}robots.txt`) {
      return new Response('User-agent: *\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url === `${SEED}sitemap.xml`) return new Response('', { status: 404 });
    if (url === SEED) return new Response('', { status: 302, headers: { location: HOSTILE_LOCATION } });
    // The redirect target the ORIGIN picked. 503 is in RETRYABLE_STATUSES, which is the arm that
    // interpolates `currentUrl` into the thrown message.
    return new Response('', { status: 503 });
  });
}

/** The real production HTTP tier, wired the way `buildMinimalRouter` wires it (no browser pool needed:
 *  map probes route through the `renderJs:'never'` arm). */
function realHttpRouter(): SmartRouter {
  const httpClient: HttpClient = { fetch: (url, options) => httpFetch(url, options) };
  return new SmartRouter({ httpClient });
}

function stubSubsystems(router: unknown): Subsystems {
  return {
    searchEngines: [], router, backendStatus: {}, browserPool: {}, pluginRegistry: {},
    shutdown: async () => {}, bootstrapSearxng: async () => {},
  } as unknown as Subsystems;
}

async function callMcp(
  name: string,
  args: Record<string, unknown>,
  router: unknown = {},
): Promise<Array<{ type: string; text: string }>> {
  const server = createMcpServer(stubSubsystems(router));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  return res.content as Array<{ type: string; text: string }>;
}

function parsed<T>(blocks: Array<{ type: string; text: string }>): T {
  return JSON.parse(blocks[0].text) as T;
}

/** The nonce of the FIRST (wigolo-authored) opening marker in a fenced string. */
function realNonce(fenced: string): string {
  const m = new RegExp(
    `${UNTRUSTED_BEGIN_PREFIX.replace(/[[\]]/g, '\\$&')}([0-9a-f]{${UNTRUSTED_NONCE_HEX_LENGTH}})`,
  ).exec(fenced);
  if (!m) throw new Error(`no opening marker in: ${fenced.slice(0, 120)}`);
  return m[1];
}

/** Every dot-path in a parsed envelope whose string value carries a fence marker. Used for the
 *  must-not-fire probes: it reports what IS wrapped, so an over-fence is as visible as an under-fence. */
function fencedPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return value.includes(UNTRUSTED_BEGIN_PREFIX) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => fencedPaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => fencedPaths(v, `${path}.${k}`));
  }
  return [];
}

function makeRaw(url: string): RawFetchResult {
  return {
    url, finalUrl: url, html: '<html><body>content</body></html>',
    contentType: 'text/html', statusCode: 200, method: 'http', headers: {},
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Seeded Page', markdown: '# Seeded\n\nOriginal body.', metadata: {},
    links: [], images: [], extractor: 'defuddle', ...overrides,
  };
}

beforeEach(() => {
  // FETCH_MAX_RETRIES=0 keeps the 503 arm to a single attempt. It changes nothing about the message
  // under test — the format is interpolated at the throw, not at the retry — and without it each
  // httpFetch spends ~2.5s in exponential backoff before delivering the identical string.
  process.env.FETCH_MAX_RETRIES = '0';
  resetConfig();
  initDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
  delete process.env.FETCH_MAX_RETRIES;
  resetConfig();
  vi.unstubAllGlobals();
});

describe('the throw site that authors the payload is pinned, not assumed', () => {
  it('FORMAT-1: an origin `Location` header reaches `err.message` byte-for-byte, in a fixed format', async () => {
    // WHY: the REST guard hand-builds its StageError with the redirect URL already spliced in, which is
    // right for testing the ASSEMBLY seam but leaves the throw site invisible — drop `currentUrl` from
    // `http-client.ts`'s 429/502/503 throw and every containment assertion in this file still passes,
    // vacuously, because there would be nothing left to contain. This drives the real redirect loop
    // instead: the payload is delivered by a `Response` `location` header, resolved by production
    // `new URL()`, and the message is compared for EQUALITY. A format change fails here, loudly, at the
    // one test whose subject is the format.
    const fetchMock = hostileFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    let message: string | null = null;
    try {
      await httpFetch(SEED);
    } catch (err) {
      message = (err as Error).message;
    }

    // Outside signal: the loop really followed the hop rather than failing at the seed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(message).toBe(THROW_FORMAT);
    // And the alphabet claim in this file's header, measured rather than asserted from memory: every
    // character of the canary survived `new URL()` normalisation.
    expect(message).toContain(CANARY);
  });
});

describe('crawl mode:map — the origin-chosen redirect target is contained on the SUCCESS envelope', () => {
  /** Drives handleCrawl → handleMapStrategy → mapUrls → describeStageError-free `String(err)` with the
   *  REAL http tier underneath. Nothing between the `Location` header and the envelope is stubbed. */
  async function hostileMapEnvelope(): Promise<Array<{ type: string; text: string }>> {
    vi.stubGlobal('fetch', hostileFetchMock());
    return callMcp('crawl', { url: SEED, strategy: 'map' }, realHttpRouter());
  }

  it('MAP-1: the payload arrives, and every occurrence of it sits inside a closed fence', async () => {
    const blocks = await hostileMapEnvelope();
    const data = parsed<MapOutput & { crawled: number }>(blocks);

    // The chain really ran and really spliced the origin's URL. Without this the containment assertion
    // below would pass on an envelope that simply never carried the payload.
    expect(data.error).toContain(CANARY);
    expect(data.error).toContain(THROW_FORMAT);
    // THE INVARIANT. The walker checks every reachable string in the serialised envelope, not the field
    // we happen to expect — so a sibling field that starts carrying the same bytes fails here too.
    expect(findUnfencedInEnvelope(blocks, CANARY)).toEqual([]);
  });

  it('MAP-2: it really is the success envelope — the map answer still ships alongside the fenced error', async () => {
    // This is what distinguishes the bug from "map failures go through stageErrorEnvelope". They do not:
    // `error` rides a body that also carries `urls`/`total_found`/`sitemap_found`/`crawled`, which is
    // exactly why `fenceCrawlData` — not the failure-envelope builder — is the seam that has to fence it.
    const blocks = await hostileMapEnvelope();
    const data = parsed<MapOutput & { crawled: number }>(blocks);

    expect(Array.isArray(data.urls)).toBe(true);
    expect(data.total_found).toBe(data.urls.length);
    expect(data.sitemap_found).toBe(false);
    expect(data.crawled).toBe(0);
    // Operational fields are untouched: no marker anywhere except the one prose field.
    expect(fencedPaths(data)).toEqual(['$.error']);
  });

  it('MAP-3: the region is closed by THIS call\'s nonce, and the nonce is fresh per call', async () => {
    const a = parsed<MapOutput>(await hostileMapEnvelope());
    vi.unstubAllGlobals();
    const b = parsed<MapOutput>(await hostileMapEnvelope());

    const nonce = realNonce(a.error!);
    expect(a.error!.endsWith(`${UNTRUSTED_END_PREFIX}${nonce}]]`)).toBe(true);
    expect(a.error!.indexOf(CANARY)).toBeGreaterThan(
      a.error!.indexOf(`${UNTRUSTED_BEGIN_PREFIX}${nonce}`),
    );
    // A page that observes one region cannot terminate the next.
    expect(realNonce(b.error!)).not.toBe(nonce);
  });
});

describe('cache check_changes — a refused re-fetch carries the same origin text', () => {
  /**
   * The SECOND route the same bytes take to a success envelope. `handleCache`'s check_changes loop puts
   * `describeStageError(raw)` into `ChangeReport.error` on a refused re-fetch, and that report ships
   * inside `data.changes[]` on an `isError: false` body — `dispatchCache` only inspects the TOP-LEVEL
   * `error`, so not even the REST status path looks at it.
   *
   * The StageError is annotated with the union member `SmartRouter.fetch` actually returns, so the
   * compiler checks the shape, and its `error_reason` is the message FORMAT-1 pinned at the real throw
   * site rather than a sentence written here. Only the code/stage pair is chosen (`fetch_failed` /
   * `fetch`, the pair the router emits for an upstream HTTP failure); the prose is production's.
   */
  function refusingRouter(): { fetch: ReturnType<typeof vi.fn> } {
    const refusal: StageError = {
      error: 'fetch_failed',
      error_reason: THROW_FORMAT,
      stage: 'fetch',
    };
    return { fetch: vi.fn(async () => refusal) };
  }

  it('CHANGES-1: `changes[].error` is contained, attributed to the row it belongs to', async () => {
    cacheContent(makeRaw('https://seeded.example/a'), makeExtraction());
    const router = refusingRouter();
    const blocks = await callMcp('cache', { check_changes: true, url_pattern: '*' }, router);
    const data = parsed<CacheOutput>(blocks);

    // Outside signals: the loop ran, and the refusal really did reach the report.
    expect(router.fetch).toHaveBeenCalledTimes(1);
    expect(data.changes).toHaveLength(1);
    expect(data.changes![0].error).toContain(CANARY);
    // `describeStageError` keeps the machine code AND the prose, so both are present — and the whole
    // sentence, code included, is inside the region because it is one prose field.
    expect(data.changes![0].error).toContain('fetch_failed');
    expect(findUnfencedInEnvelope(blocks, CANARY)).toEqual([]);
    // The region names the row's own host, which the top-level `error` cannot do (no url in scope).
    // Scheme+host only — `sanitizeOrigin` cuts the path off, because the opener line is itself a
    // channel and a bounded DNS label is all the attribution is for.
    expect(data.changes![0].error).toContain('origin=https://seeded.example]]');
  });

  it('CHANGES-2 (must-not-fire): the row\'s machine-readable fields are byte-identical', async () => {
    cacheContent(makeRaw('https://seeded.example/a'), makeExtraction());
    const blocks = await callMcp('cache', { check_changes: true, url_pattern: '*' }, refusingRouter());
    const data = parsed<CacheOutput>(blocks);
    const row = data.changes![0];

    // A fence here would break the caller: `url` is dereferenced, `changed` is the answer, and
    // `current_hash` is compared. `error` is the ONLY wrapped field on the whole envelope.
    expect(row.url).toBe('https://seeded.example/a');
    expect(row.changed).toBe(false);
    expect(row.current_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fencedPaths(data)).toEqual(['$.changes[0].error']);
  });

  it('CHANGES-3 (must-not-fire): `diff_summary` is wigolo-authored counts and stays raw', async () => {
    // The genuinely non-fired sibling, and the reason the change is a per-field spread rather than a
    // deep fence over ChangeReport. `computeDiffSummary` interpolates only line COUNTS — no page bytes
    // can reach it — so wrapping it would cost a 300-character preamble around "1 line added, …" and
    // contain nothing. A future deep-fence of this shape fails here.
    cacheContent(makeRaw('https://seeded.example/a'), makeExtraction({ markdown: '# One\n\nfirst body.' }));
    // A router that SUCCEEDS with different content is what reaches the changed branch at all.
    const changedRouter = { fetch: vi.fn(async () => makeRaw('https://seeded.example/a')) };
    const blocks = await callMcp(
      'cache',
      { check_changes: true, url_pattern: '*' },
      changedRouter,
    );
    const data = parsed<CacheOutput>(blocks);
    const row = data.changes![0];

    // Outside signal: this is the CHANGED branch, so `diff_summary` is actually populated. Without it
    // the assertion below would hold vacuously on an absent field.
    expect(row.changed).toBe(true);
    expect(row.diff_summary).toBeTruthy();
    expect(row.diff_summary).not.toContain(UNTRUSTED_BEGIN_PREFIX);
    expect(fencedPaths(data)).toEqual([]);
  });
});

describe('the top-level in-band `error` is fenced on both tools, unconditionally', () => {
  it('INBAND-1: cache\'s own refusal is delivered INTACT inside the region, not rewritten', async () => {
    // The must-not-fire probe for the OTHER direction. `handleCache`'s clear path emits an English
    // instruction with no page-derived component, and it IS fenced — rule 1 of content-fence.ts forbids
    // deciding by inspecting the value, so over-fencing a failure message is the deliberate, fail-safe
    // outcome. What must not happen is the message being mangled or dropped: the producer's exact
    // sentence has to survive inside the wrapper, or a fence has become a sanitiser.
    const blocks = await callMcp('cache', { clear: true });
    const data = parsed<CacheOutput>(blocks);
    const producerText = 'clear requires at least one filter (query, url_pattern, or since)';

    expect(data.error).toContain(producerText);
    expect(data.error).toContain(UNTRUSTED_BEGIN_PREFIX);
    expect(data.error!.endsWith(`${UNTRUSTED_END_PREFIX}${realNonce(data.error!)}]]`)).toBe(true);
    expect(fencedPaths(data)).toEqual(['$.error']);
  });

  it('INBAND-2: crawl\'s seed refusal is fenced on the PAGES branch too, not just map', async () => {
    // The two branches of `fenceCrawlData` are separate returns and the map one was the only one anyone
    // looked at. This drives the non-map shape — `handleCrawl`'s SSRF seed guard returns
    // `{ pages: [], total_found: 0, crawled: 0, error }` — so a fix applied to one branch alone fails.
    const blocks = await callMcp('crawl', { url: 'http://169.254.169.254/latest/meta-data' });
    const data = parsed<CrawlOutput>(blocks);

    expect(data.pages).toEqual([]);
    // The guard's own sentence, verbatim — over-fenced, but delivered intact rather than sanitised.
    expect(data.error).toContain('url resolves to a link-local IPv4 (169.254.169.254)');
    expect(fencedPaths(data)).toEqual(['$.error']);
  });
});
