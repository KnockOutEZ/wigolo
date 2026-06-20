import type Database from 'better-sqlite3';
import { captureFromPage } from './artifacts.js';
import { getBackgroundIndexQueue, type IndexJobInput } from '../../embedding/background-queue.js';
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
}

export function createCaptureHandler(
  deps: CaptureHandlerDeps,
): (input: StudioCaptureInput) => Promise<StudioCaptureOutput | StudioToolError> {
  return async (input: StudioCaptureInput): Promise<StudioCaptureOutput | StudioToolError> => {
    // Read ONLY the safe fields. Anything else the caller sends (a trust flag, a session id,
    // a curated flag) is never bound here, so it cannot reach the row.
    const { type, content, url } = input;

    if (type !== 'clip') {
      return {
        error_reason: 'unsupported_capture_type',
        hint: `studio_capture handles 'clip' only; '${String(type)}' is not capturable through this tool.`,
      };
    }
    if (typeof url !== 'string' || url.trim() === '') {
      return { error_reason: 'missing_url', hint: 'A clip requires the page url it was captured from.' };
    }
    if (typeof content !== 'string' || content === '') {
      return { error_reason: 'missing_content', hint: 'A clip requires content to capture.' };
    }

    const enqueue = deps.enqueue ?? ((job) => getBackgroundIndexQueue().enqueue(job));
    // content_trusted=0 + dedup + atomic embed enqueue all live in captureFromPage (4b-3).
    const result = captureFromPage(
      { type: 'clip', sessionId: deps.sessionId, url, title: '', markdown: content },
      { db: deps.db, enqueue },
    );
    return { artifact_id: result.id, inserted: result.inserted, content_hash: result.contentHash };
  };
}
