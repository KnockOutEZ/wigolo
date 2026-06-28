import { navigateSession, type NavigableBrowser } from './nav.js';
import { policyForHolder, type NavGrant } from './nav-policy.js';
import type { ControlParty } from './control-token.js';
import type { CaptureResult } from './capture/artifacts.js';

/**
 * D19 — the host-injected SESSION DRIVE SEAM.
 *
 * A session-targeted fetch/extract/crawl needs to drive (or read) a LIVE Studio session's headed browser,
 * but the agent runs on the stdio side and the live drive context (browser / control-token / nav-grant /
 * current url) is HOST-CLOSURE-LOCAL — never on the Session object (which stays metadata-only) and never on
 * the stdio side. This accessor mirrors the `studioHost` injection: the host wires a `studioSessions`
 * accessor onto Subsystems, and the cross-process tool forward resolves a session's drive through it.
 *
 * The host drives exactly ONE browser (the primary session), so `getSessionDrive` returns a drive ONLY for
 * that live session's id; any other / closed id ⇒ `undefined` ⇒ the tool surfaces an explicit error, NEVER
 * a silent ephemeral fallback.
 */

/** The result of a gated session navigation — mirrors the act handler's navigate verdict shape. */
export type GatedNavResult = { ok: true } | { ok: false; reason: string; currentEpoch?: number };

/** The narrow control-token view `gatedNavigate` needs (the real ControlToken satisfies it). */
export interface DriveControlToken {
  readonly holder: ControlParty;
  readonly epoch: number;
  assertCanDrive(party: ControlParty): { ok: true } | { ok: false; reason: string; currentEpoch: number };
}

/**
 * One live session's drive primitives. The tool-layer composition (runSessionFetch/Extract/Crawl) sequences
 * these; the SEAM keeps the host's browser/token/grant closures off the stdio side.
 */
export interface SessionDrive {
  /** The live page URL (host-observed); undefined when the browser is not started / mid-recovery. */
  currentUrl(): string | undefined;
  /**
   * Navigate the session's browser to `url`, GATED. Mirrors the act handler's NAVIGATION path EXACTLY:
   * `assertCanDrive('agent')` (the human holding ⇒ refused) + the gate-epoch fence (a reclaim in the
   * gate→start window stands down) + `navigateSession(policyForHolder('agent', grant))` whose SSRF guard
   * (`guardNavigation`) fences cloud-internal/private. It is NOT the click/type pre-grant gate — navigate
   * is never pre-granted (SSRF + the control token are its only gates).
   */
  gatedNavigate(url: string): Promise<GatedNavResult>;
  /** Read the session's CURRENT page — its url + outer HTML — WITHOUT navigating (the token-free read for extract). */
  readCurrentPage(): Promise<{ url: string; html: string }>;
  /**
   * Persist session-derived page content to the cache, content_trusted=0 BY CONSTRUCTION (routes through
   * captureFromPage; the agent can never mark session-fetched content trusted-as-instructions). Async because
   * the host resolves the live credential-context signal fresh and excludes a credential page entirely.
   */
  insertTrusted0(args: { url: string; title: string; markdown: string }): Promise<CaptureResult>;
}

/** The host-injected accessor on Subsystems (mirrors `studioHost`). Undefined on the stdio side. */
export interface StudioSessionsAccessor {
  /** The drive for a live session id, or undefined (unknown / closed / not the host's driven session). */
  getSessionDrive(id: string): SessionDrive | undefined;
}

/** The host primitives a SessionDrive closes over — supplied by `startStudioHost`. */
export interface SessionDriveDeps {
  browser: NavigableBrowser;
  controlToken: DriveControlToken;
  /** The SAME grant object the nav interceptor's policy provider reads (entry-URL + per-hop verdicts agree). */
  grant: NavGrant;
  currentUrl: () => string | undefined;
  /** Read the live page's outer HTML (host-side, via the session CDP). */
  readHtml: () => Promise<string>;
  /** Persist content_trusted=0 (captureFromPage); resolves + applies the credential-context exclusion. */
  insert: (args: { url: string; title: string; markdown: string }) => Promise<CaptureResult>;
}

/**
 * Build the drive seam for one live session from the host's closure-local primitives. `gatedNavigate` is the
 * load-bearing security surface: it is a byte-for-byte mirror of the act handler's navigate path so the
 * session fetch/crawl is gated + SSRF-fenced identically to studio_act navigate — there is no second,
 * looser navigation lane.
 */
export function createSessionDrive(deps: SessionDriveDeps): SessionDrive {
  return {
    currentUrl: deps.currentUrl,
    gatedNavigate: async (url: string): Promise<GatedNavResult> => {
      // GATE before acting (host-authoritative): the human holding ⇒ refuse, return the live epoch to resync.
      const gate = deps.controlToken.assertCanDrive('agent');
      if (!gate.ok) return { ok: false, reason: 'not_holder', currentEpoch: gate.currentEpoch };
      const gateEpoch = deps.controlToken.epoch;
      // EPOCH FENCE on entry (backstop) + SINGLE-SOURCE POLICY off the SAME grant + SSRF inside navigateSession.
      const r = await navigateSession(deps.browser, url, policyForHolder('agent', deps.grant), {
        beforeNavigate: () => deps.controlToken.holder === 'agent' && deps.controlToken.epoch === gateEpoch,
      });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    readCurrentPage: async (): Promise<{ url: string; html: string }> => ({
      url: deps.currentUrl() ?? '',
      html: await deps.readHtml(),
    }),
    insertTrusted0: (args) => deps.insert(args),
  };
}
