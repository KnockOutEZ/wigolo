import type {
  FetchInput,
  FetchOutput,
  ExtractInput,
  ExtractOutput,
  CrawlInput,
  CrawlOutput,
  StageResult,
  StageError,
} from '../types.js';
import type { StudioSessionsAccessor, GatedNavResult } from './session-drive.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { handleExtract } from '../tools/extract.js';
import { CaptureRefusedError } from './capture/artifacts.js';
import { truncateSmartly } from '../search/truncate.js';
import type { SmartRouter } from '../fetch/router.js';

/**
 * D19 — the HOST-SIDE session-targeted composition for fetch / extract / crawl. These run against a live
 * session's drive seam (resolved from the host's `studioSessions` accessor), i.e. on the side that owns the
 * browser. Core's own tools no longer call them: `src/tools/session-target.ts` is a forwarding client that
 * POSTs the session-target wire to whichever companion published the handle, and this is what answers it.
 *
 * It lives under `src/studio/` because it is domain, not seam: it drives the control token, the SSRF-fenced
 * navigate and the trusted-0 capture. It leaves with the rest of the layer at the Phase-C deletion.
 *
 * NAV-CLASS contract (HANDOFF / D19):
 *  - fetch  ALWAYS navigates (gated + SSRF-fenced) → reads the resulting page → inserts content_trusted=0.
 *  - extract reads the session's CURRENT page (the SOLE token-free read — it does NOT navigate, no gate).
 *  - crawl  ALWAYS navigates → always gated.
 * None of the three click/type, so the S7 pre-grant gate is never involved.
 */

/** Explicit "no live session" error — NEVER a silent downgrade to the ephemeral path (the D19 contract). */
function sessionNotFound(stage: string, id: string | undefined): { ok: false } & StageError {
  return {
    ok: false,
    error: 'no_such_session',
    error_reason: `No live companion session with id ${id ?? '(missing)'}.`,
    stage,
    hint: 'The session may be closed or never existed. List your live sessions for ids, or omit session_id for an ephemeral request. This is never silently downgraded to an ephemeral fetch.',
  };
}

/** Map a gated-navigation refusal to a tool error the agent can act on. */
function navError(stage: string, nav: Extract<GatedNavResult, { ok: false }>): { ok: false } & StageError {
  if (nav.reason === 'not_holder') {
    return {
      ok: false,
      error: 'not_holder',
      error_reason: 'The human holds control of this companion session — the agent cannot drive it.',
      stage,
      hint: 'Observe and wait for a grant; do not retry into the human.',
    };
  }
  if (nav.reason === 'navigation_blocked') {
    return {
      ok: false,
      error: 'navigation_blocked',
      error_reason: 'That address is blocked for the agent (cloud-internal is never allowed; localhost/private needs a human grant).',
      stage,
    };
  }
  if (nav.reason === 'aborted_reclaimed') {
    return {
      ok: false,
      error: 'aborted_reclaimed',
      error_reason: 'The human took control during navigation — do not retry; observe and wait your turn.',
      stage,
    };
  }
  // D9 refusals (pacing budget, authenticated-use grant) already carry their own reason + hint, with the
  // live counters in the text. Passing them through verbatim is the whole point of a VISIBLE budget: a
  // generic "navigation did not complete" would read as a bug.
  if (nav.error_reason) {
    return { ok: false, error: nav.reason, error_reason: nav.error_reason, stage, ...(nav.hint ? { hint: nav.hint } : {}) };
  }
  return { ok: false, error: nav.reason, error_reason: `Session navigation did not complete (${nav.reason}).`, stage };
}

/**
 * Session-targeted fetch: navigate the live session (GATED + SSRF-fenced), read the resulting page, extract,
 * persist content_trusted=0, and return the fetch shape. A credential-context page is excluded entirely
 * (the trusted-0 insert refuses it) — surfaced as a refusal, content never returned and never cached.
 */
export async function runSessionFetch(
  accessor: StudioSessionsAccessor,
  input: FetchInput,
): Promise<StageResult<FetchOutput>> {
  const drive = accessor.getSessionDrive(input.session_id!);
  if (!drive) return sessionNotFound('fetch', input.session_id);

  // Navigate-class: the gated drive navigate (the SOLE navigation lane — no ungated bypass).
  const nav = await drive.gatedNavigate(input.url);
  if (!nav.ok) return navError('fetch', nav);

  const page = await drive.readCurrentPage();
  const extractor = await getExtractProvider();
  const extraction = await extractor.extract(page.html, page.url, {
    maxChars: input.max_chars,
    section: input.section,
    sectionIndex: input.section_index,
  });

  // Trusted-0 BY CONSTRUCTION (captureFromPage). A credential-context page throws CaptureRefusedError →
  // exclude entirely (no content returned, nothing cached) — the agent must hand a login off to the human.
  try {
    await drive.insertTrusted0({ url: page.url, title: extraction.title, markdown: extraction.markdown });
  } catch (e) {
    if (e instanceof CaptureRefusedError) {
      return {
        ok: false,
        error: 'capture_refused',
        error_reason: 'The live session page is a login/credential context — its content is excluded from the agent and the cache.',
        stage: 'fetch',
        hint: 'Do not retry; hand the login off to the human.',
      };
    }
    throw e;
  }

  const markdown =
    input.max_content_chars !== undefined ? truncateSmartly(extraction.markdown, input.max_content_chars) : extraction.markdown;

  const out: FetchOutput = {
    url: page.url,
    title: extraction.title,
    markdown,
    metadata: { ...extraction.metadata },
    links: extraction.links,
    images: extraction.images,
    cached: false,
    // The bytes came off a headed browser session.
    fetch_method: 'browser',
    ...(extraction.site_data ? { site_data: extraction.site_data } : {}),
  };
  return { ok: true, data: out };
}

/**
 * Session-targeted extract: read the session's CURRENT page and run the full extract pipeline against the
 * LIVE html. The SOLE token-free read — it does NOT navigate, so there is no control-token gate and no SSRF
 * nav guard (there is no navigation). Reuses handleExtract with `html` (no url ⇒ no router fetch); the live
 * page url is post-set as source_url for citation parity.
 */
export async function runSessionExtract(
  accessor: StudioSessionsAccessor,
  input: ExtractInput,
  router: SmartRouter,
): Promise<StageResult<ExtractOutput>> {
  const drive = accessor.getSessionDrive(input.session_id!);
  if (!drive) return sessionNotFound('extract', input.session_id);

  const page = await drive.readCurrentPage();
  const r = await handleExtract({ ...input, html: page.html, url: undefined }, router);
  if (r.ok) r.data.source_url = page.url;
  return r;
}

/**
 * Session-targeted crawl: navigate the seed (GATED + SSRF-fenced) and return its page. Minimum-viable —
 * a multi-page crawl driving the live co-browse browser across the link graph is deferred (flagged, not
 * silently capped); the single-page result keeps the "crawl always navigates → always gated" contract.
 */
export async function runSessionCrawl(accessor: StudioSessionsAccessor, input: CrawlInput): Promise<CrawlOutput> {
  const drive = accessor.getSessionDrive(input.session_id!);
  if (!drive) {
    return { pages: [], total_found: 0, crawled: 0, error: `no_such_session: no live companion session with id ${input.session_id ?? '(missing)'}` };
  }
  const nav = await drive.gatedNavigate(input.url);
  if (!nav.ok) return { pages: [], total_found: 0, crawled: 0, error: nav.reason };

  const page = await drive.readCurrentPage();
  const extractor = await getExtractProvider();
  const extraction = await extractor.extract(page.html, page.url, {});
  return {
    pages: [{ url: page.url, title: extraction.title, markdown: extraction.markdown, depth: 0 }],
    total_found: 1,
    crawled: 1,
  };
}
