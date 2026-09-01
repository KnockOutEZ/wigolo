import type { StudioSessionsAccessor, SessionDrive, GatedNavResult } from './session-drive.js';
import type { StudioHostHandlers } from '../daemon/studio-dispatch.js';
import { isChallengeShell } from '../fetch/tls-tier.js';
import { classifyChallenge } from '../fetch/challenge-classify.js';

/**
 * S9 — the BROKER `studio_fetch` capability.
 *
 * This is deliberately NOT an MCP tool. It is the host-side capability the core's SmartRouter escalation
 * rung calls over the gateway transport the handle file already authenticates, so it is registered at the
 * gateway seam only — it appears in no tool schema, no TOOL_DESCRIPTIONS entry, and no listTools response.
 * Promoting it to a tool would make it the six-seam register instead.
 *
 * It reuses the shipped drive seam wholesale: `gatedNavigate` is the SAME control-token + SSRF-fenced lane
 * `studio_act` navigates through (there is no second, looser navigation path), and the credential-context
 * probe is the same one observe/marks/capture read.
 *
 * It returns the page's raw HTML rather than extracted markdown, because the caller is the core fetch
 * pipeline, which owns extraction. That also keeps this module free of the extraction graph, so the
 * gateway it is wired into still boots inside the app's main process with no native module loaded.
 *
 * Unlike `fetch(session_id:…)` it does NOT write the studio artifact rail: its bytes flow into the core
 * page cache like any other fetch tier. The credential exclusion that the artifact insert would otherwise
 * have enforced is therefore applied HERE, explicitly, before the page is read.
 */

/**
 * The capability NAME on the gateway transport. Shared by the host seam and the core-side client so the
 * two can never drift into a silent 404 (the trap CLAUDE.md records for the studio dispatch name-guards).
 */
export const STUDIO_FETCH_CAPABILITY = 'studio_fetch';

export interface StudioFetchInput {
  url: string;
}

/**
 * K6 — the failure arm is a PUBLISHED envelope, not a producer `StageError`. Its only consumer,
 * `src/daemon/studio-mcp-server.ts:55`, serializes this body verbatim to the MCP client and never routes
 * it through `stageErrorEnvelope`, so no swap happens downstream and the orientation owed here is the
 * published one: `error_reason` a stable machine code, `error` the human message, `hint` the fix
 * (docs/rest-api.md "Error shape").
 *
 * `src/tools/session-target.ts` is the near-identical session-fetch composition and carries the OPPOSITE
 * orientation, correctly: it DOES reach `stageErrorEnvelope` (src/server.ts:533-535), so it is a producer
 * and its prose `error_reason` values are not this defect. The two files deliberately differ; do not
 * "align" either one without first asking which assembly point its output reaches.
 */
export type StudioFetchResult =
  | { ok: true; url: string; html: string; session_id: string }
  | { ok: false; error_reason: string; error: string; hint?: string; challenge_class?: string };

export interface StudioFetchDeps {
  sessions: StudioSessionsAccessor;
  /** Only the two lifecycle handlers are needed — no new StudioHostHandlers method, so the literal handler maps are untouched. */
  host: Pick<StudioHostHandlers, 'list' | 'spawn'>;
}

interface ResolvedSession {
  id: string;
  drive: SessionDrive;
}

const NO_DRIVE: StudioFetchResult = {
  ok: false,
  error_reason: 'studio_no_drive',
  error: 'No live studio session could be driven for this fetch.',
  hint: 'The studio host has no drivable session and could not open one. This is never silently downgraded to a headless fetch.',
};

function navError(nav: Extract<GatedNavResult, { ok: false }>): StudioFetchResult {
  if (nav.reason === 'not_holder') {
    return {
      ok: false,
      error_reason: 'not_holder',
      error: 'The human holds control of this studio session — the agent cannot drive it.',
      hint: 'Observe and wait for a grant; do not retry into the human.',
    };
  }
  if (nav.reason === 'navigation_blocked') {
    return {
      ok: false,
      error_reason: 'navigation_blocked',
      error: 'That address is blocked for the agent (cloud-internal is never allowed; localhost/private needs a human grant).',
    };
  }
  // D9 refusals arrive with their own code + sentence + hint (live counters included). Both halves are
  // kept — a visible budget that reports itself as a generic nav failure is not visible — but they are
  // SWAPPED onto the published orientation rather than copied across: `GatedNavResult` is a producer
  // shape, where `reason` holds the code and `error_reason` holds the prose.
  if (nav.error_reason) {
    return { ok: false, error_reason: nav.reason, error: nav.error_reason, ...(nav.hint ? { hint: nav.hint } : {}) };
  }
  return { ok: false, error_reason: nav.reason, error: `Session navigation did not complete (${nav.reason}).` };
}

/**
 * Find a drivable session: prefer one the host already has (a second window per escalated fetch would make
 * the bridge anything but invisible), else ask the host to open a background one. A listed session whose
 * drive has already gone is skipped, not treated as fatal.
 */
async function resolveSession(deps: StudioFetchDeps): Promise<ResolvedSession | null> {
  const listed = await deps.host.list();
  if (!('error_reason' in listed)) {
    for (const s of listed.sessions) {
      const drive = deps.sessions.getSessionDrive(s.id);
      if (drive) return { id: s.id, drive };
    }
  }
  const spawned = await deps.host.spawn({});
  if ('error_reason' in spawned) return null;
  const drive = deps.sessions.getSessionDrive(spawned.session_id);
  return drive ? { id: spawned.session_id, drive } : null;
}

export async function runStudioFetch(deps: StudioFetchDeps, input: StudioFetchInput): Promise<StudioFetchResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) {
    return { ok: false, error_reason: 'invalid_url', error: 'studio_fetch requires a non-empty url.' };
  }

  const session = await resolveSession(deps);
  if (!session) return NO_DRIVE;

  const nav = await session.drive.gatedNavigate(url);
  if (!nav.ok) return navError(nav);

  // Credential gate BEFORE the read. A login page's html can carry a displayed one-time code or a
  // prefilled identifier, so "read it then throw it away" still put it in this process and any log line.
  // Fail-closed on a throwing probe: an unreadable page is treated as a credential context, not as safe.
  let credential: boolean;
  try {
    credential = await session.drive.isCredentialContext();
  } catch {
    credential = true;
  }
  if (credential) {
    return {
      ok: false,
      error_reason: 'capture_refused',
      error: 'The live session page is a login/credential context — its content is excluded from the agent and the cache.',
      hint: 'Do not retry; hand the login off to the human.',
    };
  }

  const page = await session.drive.readCurrentPage();

  // S9B slice 1 — A CHALLENGE SHELL IS NOT CONTENT.
  //
  // This rung is reached only after the browser tier has TERMINALLY hit a challenge
  // (`router.ts:785,803`), and the router returns this result DIRECTLY — where the browser tier's own
  // result is wrapped in `guardChallengeShell` (`router.ts:779`). So without this check, a substrate
  // that is ALSO walled converts an honest `blocked_by_challenge` into a SUCCESSFUL fetch whose body is
  // an interstitial, which then gets extracted, cached and cited as the page. That is the
  // `challenge-shell-as-content` failure class, reached by a new path.
  //
  // The GATE is `isChallengeShell`, not `classifyChallenge`. That distinction is load-bearing:
  // `classifyChallenge` is content-wins-over-markers and still under-reports a thin-but-genuine page as
  // `behavioral` (measured on example.com in the d14 spike), so gating on it would eat real pages —
  // including the protected ones the bridge exists to open. `isChallengeShell` at 2xx requires BOTH a
  // challenge marker AND the all-scaffolding skeleton shape, which is the shipped, skeleton-gated rule.
  // `classifyChallenge` is then used only to LABEL, exactly as `guardChallengeShell` uses it.
  //
  // 2xx is assumed because a DOM read carries no HTTP status. That is the CONSERVATIVE assumption: the
  // 2xx branch is the strict one (marker AND skeleton), where the anti-bot-status branch would fire on
  // a marker alone.
  if (isChallengeShell(200, page.html)) {
    return {
      ok: false,
      error_reason: 'blocked_by_challenge',
      error: 'The live browser session is also showing a bot-protection challenge for this page.',
      // The class decides whether a human could help at all: `behavioral` runs no solve rung
      // (`solve-ladder.ts:95–97`), so surfacing it is what stops a later phase promising a click that
      // cannot exist.
      challenge_class: classifyChallenge(page.html),
      hint: 'Do not retry immediately. The page is walled for the browser session too.',
    };
  }

  return { ok: true, url: page.url, html: page.html, session_id: session.id };
}
