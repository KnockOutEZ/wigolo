import type { StudioSessionsAccessor, SessionDrive, GatedNavResult } from './session-drive.js';
import type { StudioHostHandlers } from '../daemon/studio-dispatch.js';

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

export type StudioFetchResult =
  | { ok: true; url: string; html: string; session_id: string }
  | { ok: false; error: string; error_reason: string; hint?: string };

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
  error: 'studio_no_drive',
  error_reason: 'No live studio session could be driven for this fetch.',
  hint: 'The studio host has no drivable session and could not open one. This is never silently downgraded to a headless fetch.',
};

function navError(nav: Extract<GatedNavResult, { ok: false }>): StudioFetchResult {
  if (nav.reason === 'not_holder') {
    return {
      ok: false,
      error: 'not_holder',
      error_reason: 'The human holds control of this studio session — the agent cannot drive it.',
      hint: 'Observe and wait for a grant; do not retry into the human.',
    };
  }
  if (nav.reason === 'navigation_blocked') {
    return {
      ok: false,
      error: 'navigation_blocked',
      error_reason: 'That address is blocked for the agent (cloud-internal is never allowed; localhost/private needs a human grant).',
    };
  }
  // D9 refusals arrive with their own reason + hint (live counters included). Pass them through verbatim —
  // a visible budget that reports itself as a generic nav failure is not visible.
  if (nav.error_reason) {
    return { ok: false, error: nav.reason, error_reason: nav.error_reason, ...(nav.hint ? { hint: nav.hint } : {}) };
  }
  return { ok: false, error: nav.reason, error_reason: `Session navigation did not complete (${nav.reason}).` };
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
    return { ok: false, error: 'invalid_url', error_reason: 'studio_fetch requires a non-empty url.' };
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
      error: 'capture_refused',
      error_reason: 'The live session page is a login/credential context — its content is excluded from the agent and the cache.',
      hint: 'Do not retry; hand the login off to the human.',
    };
  }

  const page = await session.drive.readCurrentPage();
  return { ok: true, url: page.url, html: page.html, session_id: session.id };
}
