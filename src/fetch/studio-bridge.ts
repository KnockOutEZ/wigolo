import type { RawFetchResult } from '../types.js';
import { readHandle } from '../studio/handle.js';
import { STUDIO_FETCH_CAPABILITY } from '../studio/studio-fetch.js';
import { proxyToStudioHost } from '../daemon/studio-dispatch.js';
import { bumpEscalationCounter } from '../studio/escalation-counters.js';
import { ensureStudioRunning } from '../studio/auto-launch.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

/**
 * S9 — the core side of the Studio bridge.
 *
 * When the normal ladder terminates on a bot-protection challenge and a Studio session is LIVE, the page is
 * re-fetched through the human's real, attended browser instead. The bridge is gated on the published
 * handle: with no live host it declines instantly and the caller keeps its honest `blocked_by_challenge`.
 *
 * It rides the SAME bearer-authed, instanceId-guarded proxy the studio_* forward uses — there is no second
 * hand-rolled transport. Every failure mode returns null (decline) rather than throwing, because this is an
 * OPPORTUNISTIC rung: a bridge problem must never turn a clean challenge report into a crash.
 */

export interface StudioBridgeDeps {
  dataDir?: string;
  /** Injectable for tests; production uses the shared proxy forward. */
  call?: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>;
  /** Amended-D4 auto-launch. Injectable so tests never spawn a real app. */
  ensureRunning?: (opts: { dataDir?: string }) => Promise<{ endpoint: string } | null>;
}

/** True when a Studio host has published a live handle — the rung's gate. */
export function studioBridgeAvailable(dataDir?: string): boolean {
  return readHandle(dataDir) !== null;
}

export async function studioBridgeFetch(url: string, deps: StudioBridgeDeps = {}): Promise<RawFetchResult | null> {
  // Amended D4: if the substrate is not running, start it. Starting a process is not a consent event, and the
  // session it opens uses a clean in-memory profile — nothing of the human's is spent until D9's card says so.
  const ensure = deps.ensureRunning ?? ensureStudioRunning;
  if (!studioBridgeAvailable(deps.dataDir) && !(await ensure({ dataDir: deps.dataDir }))) return null;
  if (!studioBridgeAvailable(deps.dataDir)) return null;
  // D10(a): count the attempt BEFORE it resolves, so a hang or crash still shows up as an attempt with no
  // corresponding serve. Counting only completed calls would make the served-rate look better than it is.
  bumpEscalationCounter('bridgeAttempted', deps.dataDir);

  let parsed: unknown;
  try {
    const call = deps.call ?? ((name, args) => proxyToStudioHost(name, args, deps.dataDir));
    const result = await call(STUDIO_FETCH_CAPABILITY, { url });
    if (result.isError) {
      // A refusal (credential page, blocked navigation, no drive) is a legitimate answer, not a bug: the
      // caller falls through to its own challenge report. Logged at debug so it is diagnosable without
      // narrating a normal decline on every walled page.
      log.debug('studio bridge declined', { url, body: result.content[0]?.text?.slice(0, 200) });
      bumpEscalationCounter('bridgeDeclined', deps.dataDir);
      return null;
    }
    parsed = JSON.parse(result.content[0]?.text ?? 'null');
  } catch (err) {
    log.debug('studio bridge unreachable', { url, error: err instanceof Error ? err.message : String(err) });
    bumpEscalationCounter('bridgeDeclined', deps.dataDir);
    return null;
  }

  const body = parsed as { ok?: unknown; url?: unknown; html?: unknown } | null;
  if (!body || body.ok !== true || typeof body.html !== 'string' || body.html === '') {
    bumpEscalationCounter('bridgeDeclined', deps.dataDir);
    return null;
  }
  bumpEscalationCounter('bridgeServed', deps.dataDir);

  const finalUrl = typeof body.url === 'string' && body.url !== '' ? body.url : url;
  return {
    url,
    finalUrl,
    html: body.html,
    contentType: 'text/html',
    statusCode: 200,
    // The bytes came off a real browser — the same `method` the browser tier reports, because for every
    // downstream consumer (cache staleness, research source filtering, completeness) that is what they are.
    method: 'browser',
    headers: {},
    escalated: true,
  };
}
