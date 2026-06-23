import type Database from 'better-sqlite3';
import { captureFromPage, CaptureRefusedError } from './artifacts.js';
import { getBackgroundIndexQueue, type IndexJobInput } from '../../embedding/background-queue.js';
import type { FieldSemantics } from '../credential.js';
import type { StudioCaptureInput, StudioCaptureOutput, StudioToolError } from '../../daemon/studio-dispatch.js';

export type { StudioCaptureInput, StudioCaptureOutput } from '../../daemon/studio-dispatch.js';

/**
 * Phase 4c — the `studio_capture` host handler: the BOUNDARY CONTROL where the agent's
 * capture request meets the trust + session contract. Thin — it validates and maps the
 * MCP input to a page capture, then delegates to `captureFromPage`.
 *
 * Trust is trusted-0 BY CONSTRUCTION: this handler routes ONLY through `captureFromPage`
 * (content_trusted=0); it never references the human-note path (the only content_trusted=1
 * writer), so a page/agent capture cannot be marked trusted-as-instructions. Session is the
 * server-bound `deps.sessionId`, never a caller field. The handler destructures ONLY
 * { type, content, url } — every extra/smuggled field (trusted, session_id, curated_by_human,
 * …) is ignored by construction; the schema's additionalProperties:false is a client hint,
 * this handler is the control.
 *
 * Scope: `clip` only for 4c (the agent's co-browse capture is "save this content"). `qa` is
 * 4d's save-session-as-research shape and is added there with a real producer — no dead branch.
 */
export interface CaptureHandlerDeps {
  /** The live session id, bound server-side by the host — never a caller-supplied value. */
  sessionId: string;
  db: Database.Database;
  /** Embed-job sink; defaults to the shared background queue. Injected for tests. */
  enqueue?: (job: IndexJobInput) => unknown;
  /**
   * Slice 5b — resolve the live page's credential-context signal FRESH at capture-time (the host wires
   * this to a fresh snapshot's fields + the live page url). Threaded into captureFromPage so the single
   * persist choke excludes a credential context entirely. REQUIRED (not optional): an unwired host then
   * fails the type-check rather than silently skipping the guard (closes the absent-provider fail-open).
   * A benign provider that returns `{}` opts a path out explicitly, fail-loud.
   */
  credentialContext: () => Promise<{ pageUrl?: string; fields?: FieldSemantics[] }>;
  /**
   * Slice D4/B — the session nav-epoch getters (server-tracked; the agent supplies NO epoch). currentNavEpoch
   * is the live epoch (bumped on every allowed Document hop); lastObserveEpoch is the epoch at the agent's last
   * studio_observe page-read. REQUIRED (no `?.`, mirroring credentialContext): an unwired host fails the
   * type-check / fails LOUD at call, never silently skips the TOCTOU guard.
   */
  currentNavEpoch: () => number;
  lastObserveEpoch: () => number;
}

export function createCaptureHandler(
  deps: CaptureHandlerDeps,
): (input: StudioCaptureInput) => Promise<StudioCaptureOutput | StudioToolError> {
  return async (input: StudioCaptureInput): Promise<StudioCaptureOutput | StudioToolError> => {
    // Read ONLY the safe per-type fields. Anything else the caller sends (a trust flag, a
    // session id, a curated flag) is never bound here, so it cannot reach the row.
    const { type, content, url, question, answer } = input;
    const enqueue = deps.enqueue ?? ((job) => getBackgroundIndexQueue().enqueue(job));

    try {
      // Slice D4/B — capture-path TOCTOU close: refuse if the live page navigated since the agent's last
      // studio_observe (currentNavEpoch !== lastObserveEpoch). The capture content is agent-supplied from an
      // earlier observe; a navigation since means it no longer reflects the live page the credential check
      // below would validate. Server-tracked epochs (no agent-supplied value); checked BEFORE captureFromPage
      // so a stale capture never builds a row, and fail-fast (sync — no wasted CDP round-trip on a stale one).
      if (deps.currentNavEpoch() !== deps.lastObserveEpoch()) {
        throw new CaptureRefusedError('nav_epoch_stale');
      }
      // Slice 5b: resolve the live page's credential-context signal FRESH (one snapshot per capture)
      // and thread it into captureFromPage — the single persist choke excludes a credential context
      // entirely (no FTS row, no embed). The provider is REQUIRED (no `?.`), so it is invoked on every
      // capture (clip AND qa); an unwired host fails the type-check, never silently skips. The human-note
      // (trusted=1) writer is not reachable from this tool, so a human noting their own secret is unaffected.
      const credentialContext = await deps.credentialContext();
      const captureDeps = { db: deps.db, enqueue, credentialContext };

      // content_trusted=0 + dedup + atomic embed enqueue all live in captureFromPage (4b-3). Both
      // branches route through it (never the human-note trusted=1 path), so neither clip nor qa can
      // be marked trusted-as-instructions; the session is server-bound deps.sessionId, never a caller field.
      if (type === 'clip') {
        if (typeof url !== 'string' || url.trim() === '') {
          return { error_reason: 'missing_url', hint: 'A clip requires the page url it was captured from.' };
        }
        if (typeof content !== 'string' || content === '') {
          return { error_reason: 'missing_content', hint: 'A clip requires content to capture.' };
        }
        const result = captureFromPage(
          { type: 'clip', sessionId: deps.sessionId, url, title: '', markdown: content },
          captureDeps,
        );
        return { artifact_id: result.id, inserted: result.inserted, content_hash: result.contentHash };
      }

      if (type === 'qa') {
        // qa is url-less: a question + answer pair from the session (the "save session as research"
        // building block). The answer may be page/agent-derived → content_trusted=0 by the same path.
        if (typeof question !== 'string' || question.trim() === '') {
          return { error_reason: 'missing_question', hint: 'A qa capture requires the question.' };
        }
        if (typeof answer !== 'string' || answer.trim() === '') {
          return { error_reason: 'missing_answer', hint: 'A qa capture requires the answer.' };
        }
        const result = captureFromPage(
          { type: 'qa', sessionId: deps.sessionId, question, answer },
          captureDeps,
        );
        return { artifact_id: result.id, inserted: result.inserted, content_hash: result.contentHash };
      }

      return {
        error_reason: 'unsupported_capture_type',
        hint: `studio_capture handles 'clip' and 'qa'; '${String(type)}' is not capturable through this tool.`,
      };
    } catch (e) {
      // Slice 5b: a credential-context capture is excluded entirely — surfaced as a clean refusal, not
      // a crash. The error carries no page content/URL, so nothing sensitive is constructed here. Other
      // failures (e.g. captureFromPage's atomic enqueue rollback) propagate unchanged.
      if (e instanceof CaptureRefusedError) {
        if (e.reason === 'nav_epoch_stale') {
          // D4/B: the page navigated since the agent's last observe — the agent-supplied content is stale.
          // The hint carries NO content/url (nothing for a logger to leak); re-observe, then capture.
          return {
            error_reason: 'capture_refused',
            hint: 'The page navigated since you last observed it — re-observe the live page before capturing. Do not retry with stale content.',
          };
        }
        return {
          error_reason: 'capture_refused',
          hint: 'This page is a login/credential context — captures are excluded here so credentials are never persisted. Do not retry.',
        };
      }
      throw e;
    }
  };
}
