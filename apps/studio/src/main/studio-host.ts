import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  PageSnapshotter,
  createResolver,
  createObserver,
  createActHandler,
  createSessionDrive,
  PreGrantStore,
  StudioEventQueue,
  MarkStore,
  buildTarget,
  buildTargetFromFlat,
  indexAxByBackendNode,
  buildSnapshot,
  flattenDom,
  heal,
  generalize,
  applyGeometry,
  extractSet,
  resolveNodePath,
  neutralizeMarkers,
  isCredentialContext,
  recordAuthOrigin,
  readAuthOriginLedger,
  readOriginOverrides,
  isAuthenticatedOrigin,
  projectCookies,
  OriginBudget,
  DEFAULT_ORIGIN_BUDGET,
  DEFAULT_ANONYMOUS_ORIGIN_BUDGET,
  bumpEscalationCounter,
  LoginHandoff,
  createLoginCapture,
  SessionAuditLog,
  createBrokerFlowRecorder,
  flowIdForSession,
  UNTRUSTED_STUDIO_NOTICE,
  type AgentDriveGate,
  type CookieFacts,
  type AuthenticatedOriginOverrides,
  type StudioHostHandlers,
  type StudioSessionsAccessor,
  type SessionDrive,
  type StudioObserveInput,
  type StudioObserveOutput,
  type StudioActInput,
  type StudioActOutput,
  type StudioSpawnInput,
  type StudioSpawnOutput,
  type StudioCloseInput,
  type StudioCloseOutput,
  type StudioListOutput,
  type StudioToolError,
  type StudioMarksInput,
  type StudioMarksOutput,
  type StudioMarkView,
  type StudioGeneralizeOutput,
  type StudioCaptureInput,
  type StudioCaptureOutput,
  type StudioSayInput,
  type StudioSayOutput,
  type StudioExtractSetInput,
  type StudioExtractSetOutput,
  type ExtractSetDeps,
  type MatchSubtree,
  type CaptureResult,
  type FieldSemantics,
  type MarkPayload,
  type StructuredTarget,
  type HealCandidate,
  type GenBox,
  type AxNode,
  type DomNode,
  type ControlParty,
  type NavGrant,
  type NavigableBrowser,
  type ParkedAction,
  type RiskTier,
  type StorageStateOut,
  type HandoffCompletionContext,
  type AuditEntry,
  type AuditRecordInput,
  type FlowStep,
  type FlowProjection,
  type ResearchBriefDto,
} from 'wigolo/studio';
import type { TabDrive } from './drive-engine';
import type { BrokerClient } from './broker-client';
import { TabOwnedError } from './run-view-model';
import { originOnly } from './url-policy';
import type { QuoteMsg, RegionMsg, CaptureDto, KnowledgeHit, AuditDto } from '../shared/ipc';

// The Electron main process IS the studio session host (spec §2). This module composes
// the salvaged domain layer (perception → observe, act, session-drive) over the per-tab
// CDP transport the drive engine stood up — the exact wiring src/cli/studio.ts did over
// the Playwright backend, but in-process against webContents.debugger. It hands the MCP
// gateway a StudioHostHandlers + a StudioSessionsAccessor (D19). Marking (P2) and capture
// (P3) return an explicit not_implemented StageResult — never a silent stub.

const DEFAULT_INLINE_BUDGET = 6000;
const DEFAULT_SPILL_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_SESSION_CAP = 8;
/** S9/D9: fail-closed wait for an authenticated-use card, mirroring the risky-act approval timeout. */
const APPROVAL_TIMEOUT_MS = 120_000;

export type ApprovalRisk = 'money' | 'credential' | 'destructive';

/**
 * P6 F4: host-derived, page-text-FREE summary of one audit entry for the live timeline broadcast (M3).
 * Carries the structured columns only — the agent's verb, the host-assigned ref/direction/amount, the
 * origin-only url, the risk tier + resolved outcome + approval — NEVER raw typed text or page content.
 */
function auditToWire(e: AuditEntry): AuditDto {
  return {
    seq: e.seq,
    action: e.action,
    ...(e.target?.url ? { url: originOnly(e.target.url) } : {}),
    ...(e.target?.ref ? { ref: e.target.ref } : {}),
    ...(e.target?.direction ? { direction: e.target.direction } : {}),
    ...(e.target?.amount != null ? { amount: e.target.amount } : {}),
    ...(e.risk ? { risk: e.risk } : {}),
    ok: e.outcome.ok,
    ...(e.outcome.ok ? {} : { error_reason: e.outcome.error_reason }),
    ...(e.outcome.charsLanded != null ? { charsLanded: e.outcome.charsLanded } : {}),
    ...(e.approval ? { approval: e.approval } : {}),
    ts: e.ts,
  };
}

/** A parked risky act surfaced to the human's approval card (the host mints the id). */
export interface ParkedApprovalNotice {
  approval_id: string;
  action: string;
  risk: ApprovalRisk;
  session_id: string;
}

/** One driven tab the host builds a session context from (real: WebContentsView + drive engine; fake in tests). */
export interface HostTab {
  tabId: string;
  drive: TabDrive;
  /** Navigate the tab (the SSRF interceptor on the transport re-validates each hop). */
  browser: NavigableBrowser;
  /** Live page URL (host-observed). */
  currentUrl: () => string | undefined;
  /** Live outer HTML for the session-targeted extract/read path (D19). */
  readHtml: () => Promise<string>;
  /** P5: HOST-ONLY read-back of the tab's session storage (cookies + current-origin localStorage) for the login-handoff completion delta + profile capture. Never agent-facing, never logged. */
  storageState: () => Promise<StorageStateOut>;
  /** P5: apply a stored profile's COOKIES into the tab's session BEFORE its first navigation (D-P5-8 cookie-only restore). */
  applyStorageState: (state: StorageStateOut) => Promise<void>;
}

export interface StudioHostConfig {
  sessionCap?: number;
  inlineBudget?: number;
  spillMaxBytes?: number;
  dataDir?: string;
  /** P5: injectable login-handoff completion-poll timing (tests set small values for determinism). Defaults to LoginHandoff's built-ins (2s × 60). */
  handoffPollIntervalMs?: number;
  handoffMaxPolls?: number;
}

/**
 * The run spine, as the host reaches it (SD1). Narrow on purpose: the host records ownership and reads
 * it back, and everything it reads is a replay of the daemon's append-only log rather than a map this
 * file keeps in step by hand — which is what `tabToSession` used to be, and how agent tabs leaked.
 *
 * `RunViewModel` satisfies this structurally; a test can bind it over an in-memory store.
 */
export interface HostRuns {
  createRun(input: { task: string; sessionId?: string }): Promise<{ id: string }>;
  attachTab(runId: string, tabId: string, url?: string): Promise<void>;
  detachTab(tabId: string, reason: 'closed' | 'run_ended'): Promise<void>;
  endRun(runId: string, terminal: 'completed' | 'cancelled'): Promise<void>;
  ownerOf(tabId: string): string | undefined;
  sessionIdOf(runId: string): string | undefined;
  runForSession(sessionId: string): string | undefined;
  agentVisibleTabs(runId: string, universe?: readonly string[]): string[];
}

export interface StudioHostDeps {
  /**
   * Stand up a driven tab for a new session (host-side: create WebContentsView + await driveEngine.attachTab).
   * The tab MUST come back with its SSRF/redirect fence already armed and loaded to a SAFE blank page — the
   * agent's requested startUrl is navigated separately through the GATED path, never a raw ungated load.
   */
  createTab: (opts: { initialHolder: ControlParty; grant: NavGrant; partition: string }) => HostTab | Promise<HostTab>;
  /** Tear a session's tab down. */
  closeTab: (tabId: string) => void;
  /**
   * Every tab the window currently holds — the agent's and the human's alike, exactly the set the tab
   * layer knows about. Read pull-at-call, never cached: the point of it is the ids that have just left.
   *
   * REQUIRED rather than optional, and that is deliberate. A host that forgets to supply one has no way
   * to know a tab died behind its back, and the answer it gives the agent is stale in precisely the
   * window this exists to close — a fallback would make that silent instead of a type error.
   *
   * It NARROWS an ownership answer and never widens one: what a run owns comes from the log, and a tab
   * in here that no run attached is the human's, invisible either way (law 4).
   */
  tabUniverse: () => readonly string[];
  /** Surface a parked risky act to the human approval card (never auto-allowed). */
  onParked: (notice: ParkedApprovalNotice) => void;
  /**
   * S9/D9 §5.1 — is there a human who can actually SEE and answer an approval card right now? Wired to the
   * window's visibility: a `--hidden` window, a minimised one, or a headless host has no approval surface,
   * and D9's card must fail fast there rather than block on an answer that cannot arrive.
   *
   * FAIL-CLOSED when absent: a host that does not supply it counts as unattended. Guessing "attended" is
   * precisely what turns a safety check into a hang.
   */
  approvalSurfaceAttached?: () => boolean;
  /** P4: the agent posted a chat message (studio_say) → push it to the human's chat rail. */
  onSay?: (msg: { text: string; markId?: string; ts: number; sessionId: string }) => void;
  /** P4: the active session changed (open/close) → the renderer re-backfills captures + resets per-session UI. */
  onActiveSessionChange?: (sessionId: string | null) => void;
  /**
   * The DB broker RPC seam (P3, spec §13.9). Persistence + find_similar run in a plain-Node child so the
   * Electron main never loads a native module; the host supplies the security-gate inputs per call. Only
   * `call` is needed here — the app boots the full client (spawn/ready/teardown) in index.ts.
   */
  broker: Pick<BrokerClient, 'call'>;
  /** SD1: the run store this host records tab ownership into (law 4's single enforcement seam). */
  runs: HostRuns;
  /**
   * Capture a viewport region of a session tab as PNG bytes (P3 region clip). index.ts wires this to the
   * tab's `webContents.capturePage(rect)`. Optional: a host without it declines region clip explicitly
   * (never a silent no-op). Kept off the main path so most host tests don't need it (mock-mirror-safe).
   */
  capturePage?: (tabId: string, rect: RegionMsg['rect']) => Promise<{ png: Buffer; url: string; title: string }>;
  config?: StudioHostConfig;
  /** P5: push the login-handoff state to the human renderer (login card). NEVER carries content/storageState — only {state, origin?}. */
  onLoginHandoff?: (msg: { sessionId: string; state: 'in_progress' | 'completed' | 'failed'; origin?: string }) => void;
  /**
   * P5: the encrypted origin-scoped profile store (keychain-KEK'd AES-256-GCM). Injectable for tests; index.ts
   * supplies the real ProfileStore. Absent ⇒ the handoff still works but persists/loads nothing (clean session).
   */
  profileStore?: {
    get(id: string): Promise<{ ok: true; boundOrigin: string; storageState: string } | { ok: false; reason: string }>;
    set(id: string, boundOrigin: string, storageStateJson: string): Promise<void>;
  };
}

/** What markElement returns to the human IPC layer for the rail chip (role/name already neutralized). */
export interface MarkCreated {
  markId: string;
  role: string;
  name: string;
}

export interface StudioHost {
  handlers: StudioHostHandlers;
  sessions: StudioSessionsAccessor;
  /** Native human input landed on a tab → preempt the agent instantly (fsm → paused). */
  onHumanInput(tabId: string): void;
  /**
   * §13.8c one-click human grant — allow the agent onto loopback/RFC1918 for the ACTIVE session (the
   * DOM-to-code flow's "allow agent on localhost this session"). Revocable. link_local/cloud-metadata stays
   * hard-blocked in guardNavigation regardless of this grant. Human-only (Electron-IPC seam; PIN-SPLIT(b)).
   */
  grantLocalhost(): boolean;
  revokeLocalhost(): boolean;
  localhostGranted(): boolean;
  /** The active session id (null when none) — for host→renderer session-change signalling. */
  getActiveSessionId(): string | null;
  /**
   * P4: the human typed in the chat rail composer → a trusted `chat` human event on the active session
   * (the agent drains it in studio_observe). Credential-gated at source (dropped on a login page, like a
   * comment). Human-only (Electron-IPC seam) — NOT on StudioHostHandlers (PIN-SPLIT(b)).
   */
  postHumanChat(text: string): Promise<void>;
  /** The human's Allow/Deny from the approval card. Allow adds the matching pre-grant; both drain in the next observe. */
  resolveApproval(approvalId: string, decision: 'allow' | 'deny'): void;
  /**
   * Human marked an element (overlay → main IPC). Resolves the element-child path, stores the mark, and
   * enqueues a neutralized `mark` event for the next studio_observe — DROPPED AT SOURCE on a credential
   * page (a page-derived role/name can be a displayed secret). NOT on StudioHostHandlers: the agent
   * surface stays the sealed 7-key set (PIN-SPLIT(a)); this is a human-only Electron-IPC seam.
   */
  markElement(input: { tabId: string; path: number[]; payload: MarkPayload }): Promise<MarkCreated | StudioToolError>;
  /** Human pinned a comment on a mark → stored + a trusted `comment` event (dropped at source on a credential page). */
  addComment(input: { markId: string; text: string }): Promise<{ ok: true } | StudioToolError>;
  /**
   * Human captured a text selection (⌘⇧C) → a cited clip artifact via the broker. Credential-gated at
   * source (refused on a login page — a quote there can be a displayed secret). NOT on StudioHostHandlers
   * (human-only Electron-IPC seam; the agent surface stays the sealed set).
   */
  captureQuote(tabId: string, quote: QuoteMsg): Promise<StudioCaptureOutput | StudioToolError>;
  /**
   * Human dragged a rectangle to clip a region → a screenshot artifact (PNG on disk under
   * ~/.wigolo/studio/media, DB stores the pointer). Credential-gated at source (fail-closed BEFORE any
   * capture/write). Human-only (not on StudioHostHandlers).
   */
  captureRegion(tabId: string, rect: RegionMsg['rect']): Promise<StudioCaptureOutput | StudioToolError>;
  /** The active session's marks for the rail (host-internal mirror of studio_marks list). */
  listMarks(): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError>;
  /** The active session's captured items for the Captures rail (broker down → [] — the panel degrades quietly). */
  listCaptures(): Promise<CaptureDto[]>;
  /** P6 F4: the active session's audit trail (timeline backfill), reverse-chronological, host-summarized. */
  listAudit(): Promise<AuditDto[]>;
  /** P6 F3: synthesize the active session's captured artifacts into a research brief (or an honest empty). */
  synthesizeSession(): Promise<ResearchBriefDto>;
  /** find_similar on the current page against the LOCAL studio corpus (knowledge rail; broker down → []). */
  knowledgeSimilar(concept: string): Promise<KnowledgeHit[]>;
  /** Cleanly detach every session's tab (app quit). */
  shutdown(): Promise<void>;
}

interface ParkedRecord {
  approvalId: string;
  sessionId: string;
  domain: string | undefined;
  actionType: string;
  riskTier: RiskTier;
  /**
   * S9/D9: set for an authenticated-use grant card, which BLOCKS its navigation rather than parking it for a
   * later re-issue. The waiter is settled from `resolveApproval` — the human's card click — so there is still
   * exactly one place a decision can enter the host.
   */
  authenticatedUse?: { origin: string; settle: (decision: 'approved' | 'refused') => void };
}

interface MarkComment {
  text: string;
  author: 'human';
  ts: number;
}

interface SessionContext {
  sessionId: string;
  name: string;
  tab: HostTab;
  preGrant: PreGrantStore;
  eventQueue: StudioEventQueue;
  observe: (input: StudioObserveInput) => Promise<StudioObserveOutput | StudioToolError>;
  act: (input: StudioActInput) => Promise<StudioActOutput | StudioToolError>;
  drive: SessionDrive;
  // ── P2 marking ──
  markStore: MarkStore;
  payloads: Map<string, MarkPayload>;
  comments: Map<string, MarkComment[]>;
  /** Path (from the overlay) → StructuredTarget via a fresh AX⋈DOM fetch; null if unresolvable. */
  resolvePicked: (path: number[]) => Promise<StructuredTarget | null>;
  /** The shared credential-context probe (same one observe/marks use) for the push-path guard. */
  isCredentialPage: () => Promise<boolean>;
  /**
   * Live nav-epoch getters (the drive's NavEpoch) + the fresh credential signal — supplied to the broker
   * so the salvaged capture handler's TOCTOU + credential gates stay the single source of truth. The
   * agent supplies none of these; the host computes them from live session state at call time.
   */
  currentNavEpoch: () => number;
  lastObserveEpoch: () => number;
  credentialSignal: () => Promise<{ pageUrl?: string; fields?: FieldSemantics[] }>;
  /** studio_marks: list (heal each mark) | generalize a mark (preview). Credential-excluded. */
  marksTool: (input: StudioMarksInput) => Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError>;
  /** P6 F1: extract a marked repeating pattern into structured rows (credential-refused, SSRF-fenced pagination). */
  extractSet: (input: StudioExtractSetInput) => Promise<StudioExtractSetOutput | StudioToolError>;
  /** P5: the login-wall handoff machine for this session (close() LOCKs it). */
  handoff: LoginHandoff;
  /** P5: apply a matching-origin profile's cookies into the session before its first nav (no-op when no bound origin / no stored profile / origin mismatch). */
  loadProfile: () => Promise<void>;
  createdAt: number;
  lastActiveAt: number;
  status: 'live' | 'closed';
}

const notImplemented = (feature: string, phase: string): StudioToolError => ({
  error_reason: 'not_implemented',
  hint: `${feature} is not available yet (arrives in ${phase}).`,
});

/**
 * Map a raw act-handler result to the P1 STAGE contract (spec §5/§11): a parked risky act and a
 * reclaim-during-act are informational STAGES (non-errors), not failures — everything else passes
 * through untouched. Pure so the discriminant is unit-testable without a live CDP session.
 */
export function stageForActResult(
  r: StudioActOutput | StudioToolError,
  action: string,
  parkedApprovalId: string | undefined,
): StudioActOutput | StudioToolError {
  if (!('error_reason' in r)) return r;
  if (r.error_reason === 'parked_for_review' && parkedApprovalId) {
    return { ok: true, action, stage: 'pending_approval', approval_id: parkedApprovalId };
  }
  if (r.error_reason === 'aborted_reclaimed') {
    return { ok: true, action, stage: 'preempted', ...(r.charsLanded !== undefined ? { charsLanded: r.charsLanded } : {}) };
  }
  return r;
}

export function createStudioHost(deps: StudioHostDeps): StudioHost {
  const cfg = deps.config ?? {};
  const cap = cfg.sessionCap ?? DEFAULT_SESSION_CAP;
  const inlineBudget = cfg.inlineBudget ?? DEFAULT_INLINE_BUDGET;
  const spillMaxBytes = cfg.spillMaxBytes ?? DEFAULT_SPILL_MAX_BYTES;
  // Region-clip media root — the SAME data dir the broker uses (index.ts passes WIGOLO_DATA_DIR when set,
  // else both default to ~/.wigolo). The DB row stores a pointer; the PNG bytes live here (§6).
  // ONE resolved data dir for every host-side file the app owns. Resolved here rather than left undefined
  // for core's getConfig() to fall back on, so the app never silently reads a different profile than the one
  // it was started with.
  const dataDir = cfg.dataDir ?? process.env.WIGOLO_DATA_DIR ?? join(homedir(), '.wigolo');
  const mediaRoot = join(dataDir, 'studio', 'media');

  // S9/D9 — the per-origin budget limit and the human authenticated/anonymous origin marks. Read from the
  // env + the persisted config the CLI writes, NOT from core's getConfig(): resolving the full core config in
  // this process would pull the native cache DB, which cannot load here.
  const envLimit = (name: string, fallback: number): number => {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  };
  // TWO lanes: signed-in origins stay tight because over-driving them costs the human's account, anonymous
  // origins get a few hundred because over-driving those costs a rate-limit. Both are still provisional.
  const budgetLimit = envLimit('WIGOLO_STUDIO_ORIGIN_BUDGET', DEFAULT_ORIGIN_BUDGET);
  const anonymousBudgetLimit = envLimit('WIGOLO_STUDIO_ANONYMOUS_ORIGIN_BUDGET', DEFAULT_ANONYMOUS_ORIGIN_BUDGET);
  /** Re-read per evaluation so a `wigolo config --anonymous-origin` takes effect without an app restart. */
  const authOriginOverrides = (): AuthenticatedOriginOverrides => {
    try {
      const path = process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
      return readOriginOverrides((JSON.parse(readFileSync(path, 'utf-8')) as { settings?: Record<string, unknown> }).settings ?? {});
    } catch {
      return {};
    }
  };

  const contexts = new Map<string, SessionContext>();
  const parked = new Map<string, ParkedRecord>();
  let activeSessionId: string | null = null;
  // HOST-WIDE mark id sequence so ids are unique across concurrent sessions — a stale cross-session
  // markId then resolves to nothing (clean no_such_mark) instead of silently hitting another session's `m1`.
  let markSeq = 0;
  const mintMarkId = (): string => 'm' + ++markSeq;

  // Serialize acts per session so the park-id correlation window (park callback → return) cannot
  // interleave with a second concurrent act on the same session.
  const actChains = new Map<string, Promise<unknown>>();

  function buildContext(sessionId: string, name: string, tab: HostTab, profileOrigin: string | undefined): SessionContext {
    const transport = tab.drive.transport;
    const snapshotter = new PageSnapshotter({ tokenBudget: inlineBudget });
    const snapshot = () => snapshotter.snapshot(transport);
    const resolve = createResolver({ snapshot, cdp: transport });
    const eventQueue = new StudioEventQueue(512);
    const preGrant = new PreGrantStore();

    // ── S9/D9: ONE pacing + consent gate, shared by act-navigate and the session-drive seam ──
    // The budget is charged for EVERY origin, authenticated or not, and never consults F5 — so a predicate
    // false negative costs the prompt, never the rail. Only the card consults F5.
    const originBudget = new OriginBudget({ limit: budgetLimit, anonymousLimit: anonymousBudgetLimit });
    const driveGate: AgentDriveGate = {
      budget: originBudget,
      preGrant,
      isAuthenticatedOrigin: async (origin) => {
        // HOST-ONLY cookie read (the same read-back the login handoff uses), projected through
        // projectCookies, which drops every value before the predicate sees it. A read failure means clause
        // (b) cannot fire; the ledger and the human overrides still can.
        let cookies: CookieFacts[] = [];
        try {
          cookies = projectCookies((await tab.storageState()).cookies);
        } catch {
          /* tab gone / mid-recovery */
        }
        return isAuthenticatedOrigin({
          origin,
          cookies,
          ledger: readAuthOriginLedger(dataDir),
          overrides: authOriginOverrides(),
        });
      },
      // The card is answerable only if a human can see it. A live session context is NOT that signal — a
      // background session in a hidden window is perfectly "live" and has nobody watching, which is how a
      // safety check becomes a hang. Fail-closed: no probe wired ⇒ unattended.
      approvalSurfaceAttached: () => (deps.approvalSurfaceAttached?.() ?? false) && contexts.get(sessionId)?.status === 'live',
      requestApproval: (origin) =>
        new Promise<'approved' | 'refused'>((resolve) => {
          const approvalId = randomUUID();
          // Bounded even on the attended path: the window can be closed, or the human can simply walk away,
          // after the card is up. approvals.ts applies the same fail-closed timeout to the risky-act cards;
          // without one here a single unanswered card would pin an agent forever.
          const timer = setTimeout(() => {
            if (!parked.delete(approvalId)) return;
            resolve('refused');
          }, APPROVAL_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
          parked.set(approvalId, {
            approvalId,
            sessionId,
            domain: origin,
            actionType: 'authenticated-use',
            riskTier: 'credential',
            authenticatedUse: {
              origin,
              settle: (decision) => { clearTimeout(timer); resolve(decision); },
            },
          });
          deps.onParked({ approval_id: approvalId, action: 'use signed-in site', risk: 'credential', session_id: sessionId });
        }),
      bump: (key) => bumpEscalationCounter(key, dataDir),
    };

    // HOISTED (P5): the shared credential-context probe — the SAME one observe/marks use. The login-handoff
    // needs it (pageContext), and observe/marksTool read it below; it depends only on snapshot + tab, so it
    // is declared here at the top of buildContext. drives both the pull-path exclusion (marksView) and the
    // push-path drop-at-source (markElement/addComment enqueue).
    const isCredentialPage = async (): Promise<boolean> => {
      const snap = await snapshot();
      return isCredentialContext({ pageUrl: tab.currentUrl(), fields: snap.domByRef?.values() });
    };

    // P5: late-bound so the observer's handoffSignal thunk (read at observe-time) + the act wrapper can both
    // reference it; ASSIGNED below once isCredentialPage/eventQueue/controlToken exist.
    let handoff: LoginHandoff;

    const observe = createObserver({
      snapshot,
      eventQueue,
      inlineBudget,
      spillMaxBytes,
      dataDir: cfg.dataDir,
      currentUrl: tab.currentUrl,
      markObserved: () => tab.drive.navEpoch.markObserved(),
      handoffSignal: () => handoff.signal(), // P5: the agent PULLS login_handoff here (thunk — handoff assigned below)
    });

    // A container reset via a FUNCTION call (not a direct `= undefined`, which would let control-flow
    // analysis narrow the property to `undefined` and collapse the truthy check to `never`). The park
    // callback writes `rec` synchronously inside the awaited actHandler call, which flow analysis of a
    // plain local cannot see — the opaque reset keeps the read typed `ParkedRecord | undefined`.
    const parkBox: { rec: ParkedRecord | undefined } = { rec: undefined };
    const clearPark = (): void => { parkBox.rec = undefined; };
    // P6 F4: the per-session append-only audit log. In-memory here (no db) — the act handler records every
    // action + resolved outcome into it (act.ts:409), and each record is (a) broadcast to the live timeline
    // and (b) forwarded to the broker for durable, append-only persistence (the broker owns the native db).
    const audit = new SessionAuditLog({});
    // K34 — the in-memory audit seq the act path hands the recorder → the DURABLE seq the broker assigned.
    // Held as the PROMISE, not the resolved number: the act path calls the recorder synchronously, one
    // statement after `audit.record()`, so the persist that produces the durable seq has not settled yet.
    // Bounded below, because an entry is consumed by the very next step and a session is long-lived.
    const durableAuditSeq = new Map<number, Promise<number | undefined>>();
    const DURABLE_SEQ_RETAINED = 256;
    // K34 — the flow sidecar's recorder for THIS surface. Without it a user driving Studio through the app
    // builds no flows at all, while the CLI surface records normally.
    const flow = createBrokerFlowRecorder({
      sessionId,
      // The same privileged AX⋈DOM path a human mark resolves through, so a recorded step and a marked
      // element are the same object. Bound here rather than reusing `resolvePicked` (which takes an
      // overlay PATH, not a backendNodeId).
      seed: async (backendNodeId: number): Promise<StructuredTarget | null> => {
        const ax = (await transport.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
        const doc = (await transport.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
        return buildTarget(ax.nodes ?? [], doc.root, backendNodeId);
      },
      maxSeq: async () =>
        (await deps.broker.call<{ seq: number }>('flowMaxSeq', { flowId: flowIdForSession(sessionId) })).seq,
      // `undefined` here means the audit row never landed, and the recorder then writes nothing — which is
      // the sidecar's existing rule, not a new failure mode.
      resolveAuditSeq: (inMemorySeq: number) => durableAuditSeq.get(inMemorySeq) ?? Promise.resolve(undefined),
      insert: (step: FlowStep) => deps.broker.call<FlowProjection>('recordFlowStep', { step }),
    });
    const actHandler = createActHandler({
      flow,
      browser: tab.browser,
      controlToken: tab.drive.controlToken,
      grant: tab.drive.grant,
      resolve,
      channel: tab.drive.channel,
      currentUrl: tab.currentUrl,
      preGrant,
      audit,
      driveGate,
      park: (item: ParkedAction) => {
        const approvalId = randomUUID();
        const rec: ParkedRecord = { approvalId, sessionId, domain: item.domain, actionType: item.action, riskTier: item.risk };
        parkBox.rec = rec;
        parked.set(approvalId, rec);
        deps.onParked({ approval_id: approvalId, action: item.action, risk: item.risk as ApprovalRisk, session_id: sessionId });
      },
    });
    // Live broadcast (page-text-free) + durable persist, chained in record order so the broker's monotonic
    // (session_id, seq) stays intact. `target.url` is stripped to its ORIGIN UNCONDITIONALLY before it reaches
    // the durable row (and the wire) — the timeline only needs the origin for forensics/replay, NEVER the
    // query string, which can carry a secret (reset/SSO token, session id) on ANY page, credential-classified
    // or not (do not trust the classifier to catch every secret-bearing URL). A broker outage degrades the
    // timeline only (the session is unaffected — the persist is fire-and-forget off the act's return path).
    let auditPersist: Promise<unknown> = Promise.resolve();
    audit.onRecord((entry) => {
      tab.drive.channel.announce?.({ t: 'audit', ...auditToWire(entry) });
      const toPersist: AuditRecordInput =
        entry.target?.url ? { ...entry, target: { ...entry.target, url: originOnly(entry.target.url) } } : entry;
      // K34: the returned `{ seq }` used to be DISCARDED, and the flow sidecar would then have joined on
      // the host's in-memory seq. Both counters start at 1, so they agree until a persist fails — and this
      // `.catch` is exactly that failure, after which every later durable seq is offset by one and the
      // sidecar's `audit_seq` silently points at a DIFFERENT action's row. `013-studio-flows.sql` puts no
      // foreign key on the column, so nothing downstream would have caught it.
      const persisted: Promise<number | undefined> = auditPersist
        .then(() => deps.broker.call<{ seq: number }>('persistAudit', { sessionId, entry: toPersist }))
        .then((r) => r.seq)
        .catch(() => undefined); /* broker down → timeline degrades; session + agent line unaffected */
      durableAuditSeq.set(entry.seq, persisted);
      // Keep the map bounded: the recorder consumes an entry on the act immediately following, so a window
      // of the most recent few hundred is far more than any in-flight step needs.
      if (durableAuditSeq.size > DURABLE_SEQ_RETAINED) {
        for (const k of durableAuditSeq.keys()) {
          if (durableAuditSeq.size <= DURABLE_SEQ_RETAINED) break;
          durableAuditSeq.delete(k);
        }
      }
      auditPersist = persisted;
    });

    const actImpl = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
      clearPark();
      const r = await actHandler(input);
      const action = typeof input.action === 'string' ? input.action : String((input as { action?: unknown }).action);
      return stageForActResult(r, action, parkBox.rec?.approvalId);
    };

    const act = (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
      const prior = actChains.get(sessionId) ?? Promise.resolve();
      const run = prior.then(() => actImpl(input), () => actImpl(input));
      actChains.set(sessionId, run.catch(() => undefined));
      return run;
    };

    const drive = createSessionDrive({
      browser: tab.browser,
      controlToken: tab.drive.controlToken,
      grant: tab.drive.grant,
      currentUrl: tab.currentUrl,
      readHtml: tab.readHtml,
      // P3 — a session-targeted fetch persists through the DB broker (native module stays out of the
      // Electron main). Return-shape is CaptureResult (what insertTrusted0 consumes). The fresh credential
      // signal rides along so the broker re-gates (a session fetch of a login page never persists).
      insert: async ({ url, title, markdown }) =>
        deps.broker.call<CaptureResult>('persistSessionFetch', {
          sessionId, url, title, markdown, credentialSignal: await credentialSignal(),
        }),
      // S9: the SAME shared probe observe/marks/capture read. The bridge does not persist through the
      // artifact rail, so this is where its credential exclusion comes from.
      isCredentialContext: isCredentialPage,
      driveGate,
    });

    // ── P2 marking (in-memory per session; DB persistence is P3, native cache can't load in Electron) ──
    const markStore = new MarkStore(mintMarkId); // host-wide unique ids (no cross-session m1 collision)
    const payloads = new Map<string, MarkPayload>();
    const comments = new Map<string, MarkComment[]>();

    // One fresh AX⋈DOM fetch → all candidate targets (ported from src/cli/studio.ts; sessionBrowser.cdp →
    // transport). O(N) via a single flatten + AX-index. DR-4: skip wigolo's own overlay chrome (the
    // closed-shadow host carries data-wigolo-overlay) so the agent never heals/generalizes/acts on it.
    const buildHealCandidates = async (): Promise<HealCandidate[]> => {
      const ax = (await transport.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
      const doc = (await transport.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
      const snap = buildSnapshot(ax.nodes ?? [], doc.root, { tokenBudget: inlineBudget });
      const flat = flattenDom(doc.root).map;
      const axByBe = indexAxByBackendNode(ax.nodes ?? []);
      const isOverlay = (be: number): boolean => {
        let cur: number | null = be, guard = 0;
        while (cur != null && guard++ < 200) {
          const d = flat.get(cur);
          if (!d) break;
          if (d.attrs['data-wigolo-overlay'] !== undefined) return true;
          cur = d.parent;
        }
        return false;
      };
      const candidates: HealCandidate[] = [];
      for (const [ref, backendNodeId] of snap.refMap) {
        if (isOverlay(backendNodeId)) continue;
        const target = buildTargetFromFlat(flat, axByBe, backendNodeId);
        if (target) candidates.push({ ref, target });
      }
      return candidates;
    };

    // Path (from the overlay) → backendNodeId (fresh DOM) → StructuredTarget. Null if the node is gone or
    // the path is stale — declined, never a wrong element.
    const resolvePicked = async (path: number[]): Promise<StructuredTarget | null> => {
      const ax = (await transport.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
      const doc = (await transport.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
      const backendNodeId = resolveNodePath(doc.root, path);
      if (backendNodeId == null) return null;
      return buildTarget(ax.nodes ?? [], doc.root, backendNodeId);
    };

    // Viewport-relative box of a live node (CSS px) for the generalize geometric tiebreaker; null when
    // the node has no box (display:none / detached) — applyGeometry keeps such a structural match.
    const boxForNode = async (backendNodeId: number): Promise<GenBox | null> => {
      try {
        const r = (await transport.send('DOM.getBoxModel', { backendNodeId })) as { model?: { content?: number[] } };
        const q = r.model?.content;
        if (!q || q.length < 8) return null;
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      } catch {
        return null;
      }
    };

    // Broker gate inputs (P3): the live nav-epoch (drive's NavEpoch — sentinel lastObserve=-1 refuses a
    // pre-observe capture) and the fresh credential signal (SAME source isCredentialPage uses). Array-ify
    // domByRef.values() — the Iterable can't cross the JSON-RPC boundary and the broker types fields[].
    const currentNavEpoch = (): number => tab.drive.navEpoch.current;
    const lastObserveEpoch = (): number => tab.drive.navEpoch.lastObserve;
    const credentialSignal = async (): Promise<{ pageUrl?: string; fields?: FieldSemantics[] }> => {
      const snap = await snapshot();
      return { pageUrl: tab.currentUrl(), fields: [...(snap.domByRef?.values() ?? [])] };
    };

    // ── P5 login-wall handoff + encrypted origin-scoped profile (salvaged arc, Electron-backed) ──
    // On an agent act that lands in a credential context, afterAgentAct() reclaims to the human + signals
    // in_progress; the bounded poll detects completion (left credential context + a meaningful storageState
    // delta); onComplete persists origin-scoped; the machine re-grants. handoffSignal (above) feeds the
    // agent's studio_observe; onSignalChange pushes to the human renderer. storageState() is HOST-ONLY.
    const controlToken = tab.drive.controlToken;
    const profileId = profileOrigin ? createHash('sha256').update(profileOrigin).digest('hex') : undefined;
    const onLoginComplete =
      profileOrigin && profileId && deps.profileStore
        ? (async (hc: HandoffCompletionContext): Promise<void> => {
            const capture = createLoginCapture({
              profilePersist: deps.profileStore!,
              profileId,
              expectedOrigin: profileOrigin,
              onOriginMismatch: () => {
                /* confused-deputy refusal — never log the storageState; refuse-persist is the salvaged default */
              },
            });
            try {
              await capture(hc);
            } catch {
              /* keychain-unavailable / persist failure must not strand the re-grant (settleCompleted grants in
                 finally); the completed card claims NO persistence (D-P5-7), so a silent non-persist is honest */
            }
          })
        : undefined;

    handoff = new LoginHandoff({
      controlToken,
      eventQueue,
      pageContext: isCredentialPage,
      storageState: () => tab.storageState(),
      currentUrl: tab.currentUrl,
      onComplete: onLoginComplete,
      // F5 clause (a): a completed handoff is by definition a human login, so the ledger writer is the
      // human channel. Best-effort inside the machine — a ledger write never strands the agent.
      recordAuthenticatedOrigin: (origin) => recordAuthOrigin(origin, 'human'),
      onSignalChange: (s) => deps.onLoginHandoff?.({ sessionId, state: s?.state ?? 'failed', origin: profileOrigin }),
      ...(cfg.handoffPollIntervalMs !== undefined ? { pollIntervalMs: cfg.handoffPollIntervalMs } : {}),
      ...(cfg.handoffMaxPolls !== undefined ? { maxPolls: cfg.handoffMaxPolls } : {}),
    });
    // A control-token flip TO the agent during the window can only be an explicit human grant — end the
    // window (the machine never grants itself; the agent can't self-grant).
    controlToken.onChange((s) => handoff.onControlChange(s.holder));

    // The act wrapper: run the EXISTING serialized `act`, then afterAgentAct() for page-changing verbs (a
    // scroll cannot surface a wall). Mirrors src/cli/studio.ts:864; does NOT re-wrap the actChains chain.
    const actWithHandoff = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
      const r = await act(input);
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'navigate' || action === 'click' || action === 'type') await handoff.afterAgentAct();
      return r;
    };

    // Apply a matching-origin profile's cookies into the fresh in-memory partition BEFORE the first nav.
    // profile_absent / malformed → clean session (D-P5-10); r.boundOrigin re-check = defense-in-depth on the
    // confused-deputy (the sha256(origin) key already implies it, but keep the last barrier explicit).
    const loadProfile = async (): Promise<void> => {
      if (!profileId || !profileOrigin || !deps.profileStore) return;
      const r = await deps.profileStore.get(profileId);
      if (!r.ok) return;
      if (r.boundOrigin !== profileOrigin) return;
      try {
        await tab.applyStorageState(JSON.parse(r.storageState) as StorageStateOut);
      } catch {
        /* corrupt/unparseable blob → clean session (the human re-logs in) */
      }
    };

    // studio_marks list: each mark's page-derived descriptor (neutralized, trusted:false) + its CURRENT
    // heal verdict against ONE fresh candidate build. Rich payload rides along (§5), also neutralized.
    const neutralizePayload = (p: MarkPayload): MarkPayload => ({
      tag: p.tag,
      id: neutralizeMarkers(p.id),
      classes: p.classes.map(neutralizeMarkers),
      attrs: Object.fromEntries(Object.entries(p.attrs).map(([k, v]) => [k, neutralizeMarkers(v)])),
      dataset: Object.fromEntries(Object.entries(p.dataset).map(([k, v]) => [k, neutralizeMarkers(v)])),
      text: neutralizeMarkers(p.text),
      component: p.component === null ? null : neutralizeMarkers(p.component),
      source: p.source ? { file: neutralizeMarkers(p.source.file), line: p.source.line } : null,
    });

    const marksView = async (): Promise<StudioMarksOutput> => {
      const all = markStore.list();
      if (all.length === 0) return { marks: [], untrusted_notice: UNTRUSTED_STUDIO_NOTICE };
      const candidates = await buildHealCandidates();
      return {
        marks: all.map((m) => {
          const h = heal(m.target, candidates);
          const view: StudioMarkView = {
            markId: m.markId,
            // D8b: neutralize the boundary marker in the mark's page-derived display text (role/name).
            role: neutralizeMarkers(m.target.role),
            name: neutralizeMarkers(m.target.name),
            trusted: false,
            confidence: h.confidence,
          };
          if (h.ref) view.ref = h.ref;
          const pl = payloads.get(m.markId);
          if (pl) view.payload = neutralizePayload(pl);
          return view;
        }),
        untrusted_notice: UNTRUSTED_STUDIO_NOTICE,
      };
    };

    // studio_marks{op:'generalize'}: PREVIEW the repeating sibling set (requires_confirmation:true — never acts).
    const generalizeMark = async (markId?: string): Promise<StudioGeneralizeOutput | StudioToolError> => {
      if (!markId) return { error_reason: 'missing_mark_id', hint: "op='generalize' needs a markId — read studio_marks for live ids." };
      const m = markStore.get(markId);
      if (!m) return { error_reason: 'no_such_mark', hint: 'That mark id is not in the current session. Re-read studio_marks for live ids.' };
      const structural = generalize(m.target, await buildHealCandidates());
      const boxes = new Map<string, GenBox>();
      for (const match of structural.matches) {
        const box = await boxForNode(match.backendNodeId);
        if (box) boxes.set(match.ref, box);
      }
      const refined = applyGeometry(structural, boxes);
      return { markId, refs: refined.refs, confidence: refined.confidence, requires_confirmation: true };
    };

    // ── P6 F1 grab-all — extract a marked repeating pattern into structured rows ──
    // CDP DOM.Node → the pure MatchSubtree shape the row-inference core consumes (light-DOM only, §13.8a).
    const domToSubtree = (n: DomNode): MatchSubtree => ({
      nodeType: n.nodeType ?? 1,
      nodeName: n.nodeName ?? '',
      nodeValue: n.nodeValue,
      children: (n.children ?? []).map(domToSubtree),
    });
    // Depth-first search for the CDP node with a given backendNodeId (light DOM only — no shadow/frame pierce).
    const subtreeByBackendNodeId = (root: DomNode | undefined, be: number): DomNode | null => {
      if (!root) return null;
      const stack: DomNode[] = [root];
      let guard = 0;
      while (stack.length && guard++ < 200000) {
        const n = stack.pop()!;
        if (n.backendNodeId === be) return n;
        for (const c of n.children ?? []) stack.push(c);
      }
      return null;
    };
    // Fetch AX⋈DOM ONCE and return both the heal candidates and the raw doc root (so a match's backendNodeId
    // can be resolved to its subtree). Mirrors buildHealCandidates' candidate build; kept separate so that
    // path stays untouched.
    const fetchCandidatesWithDoc = async (): Promise<{ candidates: HealCandidate[]; docRoot: DomNode | undefined }> => {
      const ax = (await transport.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
      const doc = (await transport.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
      const snap = buildSnapshot(ax.nodes ?? [], doc.root, { tokenBudget: inlineBudget });
      const flat = flattenDom(doc.root).map;
      const axByBe = indexAxByBackendNode(ax.nodes ?? []);
      const isOverlay = (be: number): boolean => {
        let cur: number | null = be, guard = 0;
        while (cur != null && guard++ < 200) {
          const d = flat.get(cur);
          if (!d) break;
          if (d.attrs['data-wigolo-overlay'] !== undefined) return true;
          cur = d.parent;
        }
        return false;
      };
      const candidates: HealCandidate[] = [];
      for (const [ref, backendNodeId] of snap.refMap) {
        if (isOverlay(backendNodeId)) continue;
        const target = buildTargetFromFlat(flat, axByBe, backendNodeId);
        if (target) candidates.push({ ref, target });
      }
      return { candidates, docRoot: doc.root };
    };
    // Resolve a mark's generalized match cluster (minus exclude_refs) into subtrees + the excluded count.
    const resolveExtractCluster: ExtractSetDeps['resolveCluster'] = async (markId, excludeRefs) => {
      const m = markStore.get(markId);
      if (!m) return { error: 'no_such_mark' as const };
      const { candidates, docRoot } = await fetchCandidatesWithDoc();
      const structural = generalize(m.target, candidates);
      const boxes = new Map<string, GenBox>();
      for (const match of structural.matches) {
        const box = await boxForNode(match.backendNodeId);
        if (box) boxes.set(match.ref, box);
      }
      const refined = applyGeometry(structural, boxes);
      const excludeSet = new Set(excludeRefs);
      const keptRefs = refined.refs.filter((r) => !excludeSet.has(r));
      const excludedCount = refined.refs.length - keptRefs.length;
      const beByRef = new Map(structural.matches.map((mm) => [mm.ref, mm.backendNodeId]));
      const subtrees: MatchSubtree[] = [];
      for (const ref of keptRefs) {
        const be = beByRef.get(ref);
        const node = be == null ? null : subtreeByBackendNodeId(docRoot, be);
        if (node) subtrees.push(domToSubtree(node));
      }
      return { subtrees, refs: keptRefs, excludedCount };
    };
    // Find a same-page "next"-style control from the live candidates and drive to its href through the SAME
    // gated nav choke human/agent nav uses (guardNavigation SSRF-fenced; cloud-metadata always blocked; a
    // private hop needs the session's localhost grant, else it is REFUSED — never auto-followed).
    const followNextPage: ExtractSetDeps['followNextPage'] = async () => {
      const { candidates } = await fetchCandidatesWithDoc();
      const NEXT = /(?:^|\b)(next|more|›|»|older)(?:\b|$)/i;
      const here = tab.currentUrl();
      const hit = candidates.find(
        (c) => (c.target.role === 'link' || c.target.role === 'button') && NEXT.test(c.target.name) && typeof c.target.attrs.href === 'string',
      );
      const href = hit?.target.attrs.href;
      if (!href) return { followed: false };
      let nextUrl: string;
      try {
        nextUrl = here ? new URL(href, here).toString() : href;
      } catch {
        return { followed: false };
      }
      const r = await drive.gatedNavigate(nextUrl);
      // The nav model has NO per-hop approval-parking: a private/blocked hop is REFUSED (stronger than a park —
      // zero rows leaked). followed:false stops the accumulation; the core's pending_approval branch is unused here.
      return { followed: r.ok };
    };
    const extractSetTool = async (input: StudioExtractSetInput): Promise<StudioExtractSetOutput | StudioToolError> => {
      const result = await extractSet(input, {
        resolveCluster: resolveExtractCluster,
        isCredentialPage,
        followNextPage,
        persist: async ({ columns, rows }) => {
          const r = await deps.broker.call<CaptureResult>('persistExtraction', {
            sessionId,
            url: tab.currentUrl() ?? '',
            columns,
            rows,
            credentialSignal: await credentialSignal(),
          });
          return { id: r.id, inserted: r.inserted, contentHash: r.contentHash, columns, rows };
        },
        caps: { maxPagesCeiling: 20, maxRowsCeiling: 1000, defaultPages: 5, defaultRows: 200 },
      });
      // no_such_mark is a typed tool error; every other outcome (incl. the refused/pending_approval STAGES) is a result.
      if (result.error_reason) return { error_reason: result.error_reason, hint: result.hint ?? '' };
      return {
        columns: result.columns ?? [],
        rows: result.rows ?? [],
        pages_followed: result.pages_followed ?? 0,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.excluded !== undefined ? { excluded: result.excluded } : {}),
        ...(result.artifact_id !== undefined ? { artifact_id: result.artifact_id } : {}),
        ...(result.stage ? { stage: result.stage } : {}),
        ...(result.id ? { approval_id: result.id } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    };

    const marksTool = async (input: StudioMarksInput): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError> => {
      // 5e-0: studio_marks is an ungated agent read whose marks carry page-derived role/name — a displayed
      // secret if a mark was made on a credential screen. Exclude all mark content on a credential context.
      if (await isCredentialPage()) return { marks: [], credentialContext: true, untrusted_notice: UNTRUSTED_STUDIO_NOTICE };
      return input.op === 'generalize' ? generalizeMark(input.markId) : marksView();
    };

    return {
      sessionId,
      name,
      tab,
      preGrant,
      eventQueue,
      observe,
      act: actWithHandoff, // P5: the SessionContext.act slot runs afterAgentAct after page-changing verbs
      drive,
      markStore,
      payloads,
      comments,
      resolvePicked,
      isCredentialPage,
      currentNavEpoch,
      lastObserveEpoch,
      credentialSignal,
      marksTool,
      extractSet: extractSetTool,
      handoff,
      loadProfile,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      status: 'live',
    };
  }

  /**
   * Which session a tab belongs to, resolved through the run that owns it.
   *
   * This used to be a `tabToSession` map the host maintained beside the real ownership record, and it
   * drifted: the agent close path never deleted from it. Now the run log answers "who owns this tab"
   * and `run.created` answers "which session drives that run", so there is nothing to keep in step.
   * A tab the human opened has no owner and therefore no session — the refusals below are what makes
   * law 4's user group invisible rather than merely unlisted.
   */
  function sessionForTab(tabId: string): string | undefined {
    const runId = deps.runs.ownerOf(tabId);
    return runId ? deps.runs.sessionIdOf(runId) : undefined;
  }

  function targetContext(): SessionContext | undefined {
    if (activeSessionId) {
      const c = contexts.get(activeSessionId);
      if (c && c.status === 'live') return c;
    }
    // Fall back to any live session (the most recently created).
    for (const c of [...contexts.values()].reverse()) if (c.status === 'live') return c;
    return undefined;
  }

  const noActive = (): StudioToolError => ({
    error_reason: 'no_active_session',
    hint: 'No session is open — call studio_open first.',
  });

  async function open(input: StudioSpawnInput): Promise<StudioSpawnOutput | StudioToolError> {
    if ([...contexts.values()].filter((c) => c.status === 'live').length >= cap) {
      return { error_reason: 'studio_session_limit', hint: `The per-host session limit (${cap}) is reached — close a session before opening another.` };
    }
    const sessionId = randomUUID();
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `session ${contexts.size + 1}`;
    // An agent-opened session starts under AGENT control (a background lane with no human attached),
    // per the control-token S5 rule — so the agent can drive its own session without a human grant.
    const grant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: false };
    // P5: the origin the session's encrypted profile binds to (the startUrl origin). Undefined ⇒ no binding ⇒
    // the handoff still reclaims/waits/resumes but persists/loads nothing (a clean session).
    let profileOrigin: string | undefined;
    if (typeof input.startUrl === 'string' && input.startUrl.trim()) {
      try {
        profileOrigin = new URL(input.startUrl).origin;
      } catch {
        profileOrigin = undefined;
      }
    }
    const tab = await deps.createTab({ initialHolder: 'agent', grant, partition: `studio-${sessionId}` });
    const ctx = buildContext(sessionId, name, tab, profileOrigin);
    contexts.set(sessionId, ctx);
    // SD1 §7.3: a session is how a client connects, a run is the task. The run is created here, records
    // the session that spawned it, and takes ownership of the tab — the one place law 4's "a tab belongs
    // to exactly one run" is checked, so a tab another run holds is refused before the session goes live.
    //
    // Both failures are REFUSALS, not exceptions: the agent gets a designed tool result rather than an
    // unhandled throw at the gateway (law 9). And both roll the half-open session back, because a session
    // whose tabs no run owns is one law 4 cannot police and no surface can see.
    let run: { id: string } | undefined;
    try {
      run = await deps.runs.createRun({ task: name, sessionId });
      await deps.runs.attachTab(run.id, tab.tabId, typeof input.startUrl === 'string' ? input.startUrl : undefined);
    } catch (err) {
      ctx.status = 'closed';
      contexts.delete(sessionId);
      try { deps.closeTab(tab.tabId); } catch { /* best-effort teardown */ }
      // The session and the tab above are in-memory, but the run is DURABLE and the log is append-only
      // with no reaper — so a run created before the attach failed would sit at `running` forever,
      // counted in the tray, returned by `GET /v1/runs?status=running` and listed in the renderer, while
      // describing a session that no longer exists and owning no tab. Rolling it back means ending it,
      // because the only way to retract a fact from an append-only log is to write its terminal one.
      // `endRun` releases anything it still owns first, so law 4 never ends up with a run on a dead tab.
      //
      // Best-effort like `close`'s, and for the same reason: the refusal below is the answer the agent
      // gets either way, and the store that cannot take this terminal event is the very store that just
      // refused the attach. A run left running is visible and recoverable; a throw here would replace a
      // designed refusal with an unhandled one at the gateway (law 9).
      if (run) {
        try {
          await deps.runs.endRun(run.id, 'cancelled');
        } catch (endErr) {
          process.stderr.write(`[studio] could not end run ${run.id} after a refused open: ${endErr instanceof Error ? endErr.message : String(endErr)}\n`);
        }
      }
      if (err instanceof TabOwnedError) {
        return { error_reason: 'tab_already_owned', hint: 'That tab already belongs to another run — two runs never share a tab.' };
      }
      return { error_reason: 'run_unavailable', hint: 'The run record could not be opened, so no session was started — the local background service is not available right now.' };
    }
    activeSessionId = sessionId;
    deps.onActiveSessionChange?.(activeSessionId); // P4: renderer re-backfills captures / resets per-session UI
    await ctx.loadProfile(); // P5: apply a matching-origin profile's cookies into the fresh partition BEFORE the gated nav
    // The agent's requested startUrl is navigated through the GATED path (guardNavigation under agent
    // policy — cloud-metadata/RFC1918 fenced), NEVER a raw ungated tab load. A blocked/failed nav still
    // opens the session (on the safe blank page); the agent sees the outcome on its next observe/act.
    if (typeof input.startUrl === 'string' && input.startUrl.trim()) {
      await ctx.drive.gatedNavigate(input.startUrl);
    }
    return { session_id: sessionId };
  }

  const handlers: StudioHostHandlers = {
    observe: async (input) => {
      const ctx = targetContext();
      if (!ctx) return noActive();
      ctx.lastActiveAt = Date.now();
      return ctx.observe(input);
    },
    act: async (input) => {
      const ctx = targetContext();
      if (!ctx) return noActive();
      ctx.lastActiveAt = Date.now();
      return ctx.act(input);
    },
    marks: async (input) => {
      const ctx = targetContext();
      if (!ctx) return noActive();
      ctx.lastActiveAt = Date.now();
      return ctx.marksTool(input);
    },
    capture: async (input: StudioCaptureInput): Promise<StudioCaptureOutput | StudioToolError> => {
      const ctx = targetContext();
      if (!ctx) return noActive();
      ctx.lastActiveAt = Date.now();
      // The agent supplies NO gate inputs; the host computes session id + nav-epoch + a FRESH credential
      // signal from live session state and passes them to the broker, where the salvaged handler is the
      // single source of truth for the TOCTOU + credential + trust gates. Broker down → fail-fast refusal
      // (never throws, never hangs — §11), not a crash.
      try {
        return await deps.broker.call<StudioCaptureOutput | StudioToolError>('capture', {
          input,
          sessionId: ctx.sessionId,
          currentNavEpoch: ctx.currentNavEpoch(),
          lastObserveEpoch: ctx.lastObserveEpoch(),
          credentialSignal: await ctx.credentialSignal(),
        });
      } catch {
        return { error_reason: 'capture_unavailable', hint: 'The local library service is not available — captures cannot be saved right now.' };
      }
    },
    spawn: open,
    close: async (input: StudioCloseInput): Promise<StudioCloseOutput | StudioToolError> => {
      const id = typeof input.session_id === 'string' ? input.session_id : '';
      const ctx = contexts.get(id);
      if (!ctx || ctx.status === 'closed') {
        return { error_reason: 'no_such_session', hint: 'That session is unknown or already closed.' };
      }
      ctx.status = 'closed';
      ctx.handoff.onClientGone(); // P5: LOCK an in-flight handoff (clear timers; no re-grant after teardown)
      deps.closeTab(ctx.tab.tabId);
      // The run is the unit, so its end is a recorded fact rather than a deleted map entry: `endRun`
      // releases every tab it still owns and then writes the terminal event.
      //
      // Best-effort, unlike `open`'s: the tab is already destroyed by the line above, so throwing here
      // would leave the session half-closed — its context and any parked approval below never reclaimed
      // — and refuse a close the human already got. An unwritten terminal event leaves the run showing
      // as running, which is visible and recoverable; a leaked half-closed session is neither.
      const runId = deps.runs.runForSession(id);
      if (runId) {
        try {
          await deps.runs.endRun(runId, 'completed');
        } catch (err) {
          process.stderr.write(`[studio] could not record the end of run ${runId}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      actChains.delete(id);
      // Reclaim every map keyed on this session — else a long-lived host leaks a full SessionContext
      // (+ its snapshotter/queue/closures) and any never-resolved parked approval, per open/close cycle.
      for (const [aid, rec] of parked) if (rec.sessionId === id) parked.delete(aid);
      contexts.delete(id);
      if (activeSessionId === id) {
        activeSessionId = targetContext()?.sessionId ?? null;
        deps.onActiveSessionChange?.(activeSessionId); // P4: the active session switched (or went to none)
      }
      return { closed: true, session_id: id };
    },
    // The agent-visible enumeration. Tabs are taken from what each RUN owns, never from the window's tab
    // set filtered down — so a tab the human opened has no route into this answer even by accident.
    //
    // The universe is a NARROWING of that ownership answer, not its source (SD1 exit-9, K8). A tab the
    // human closes leaves the window at once and its release is a broker round-trip behind, queued on
    // the tab's own lane; between the two the log still says the run owns it. Listed unnarrowed, the
    // agent gets an id that no longer exists and its next act against it fails deep in the engine
    // instead of here. Read ONCE per call, so every session in one listing answers from one universe.
    list: async (): Promise<StudioListOutput> => {
      const universe = deps.tabUniverse();
      return {
        sessions: [...contexts.values()].map((c) => {
          const runId = deps.runs.runForSession(c.sessionId);
          return {
            id: c.sessionId,
            status: c.status,
            clients: 0,
            createdAt: c.createdAt,
            lastActiveAt: c.lastActiveAt,
            ...(runId ? { runId, tabIds: deps.runs.agentVisibleTabs(runId, universe) } : { tabIds: [] }),
          };
        }),
      };
    },
    // P4: agent→human chat post. Agent-authored text only; the renderer renders it as an inert text node
    // (no page content, no control/approval power — a legitimate 8th agent verb, PIN-SPLIT(b) intact).
    say: async (input: StudioSayInput): Promise<StudioSayOutput | StudioToolError> => {
      const ctx = targetContext();
      if (!ctx) return noActive();
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return { error_reason: 'empty_message', hint: 'studio_say needs a non-empty text.' };
      ctx.lastActiveAt = Date.now();
      const ts = Date.now();
      deps.onSay?.({ text, ...(typeof input.markId === 'string' ? { markId: input.markId } : {}), ts, sessionId: ctx.sessionId });
      return { posted: true, posted_at: ts };
    },
    // P6 F1 — resolve by tab_id, reject a tab that is unknown OR not in the ACTIVE session (confused-deputy
    // fence — never coerce to active via targetContext, which would let a stale tab_id hit another session).
    extractSet: async (input: StudioExtractSetInput): Promise<StudioExtractSetOutput | StudioToolError> => {
      // tab_id is OPTIONAL (no agent tool surfaces one): omitted ⇒ the active session's tab. When PROVIDED it
      // must belong to the active session — a tab_id from another session is REFUSED, never coerced to active
      // (confused-deputy fence). This keeps the fence for explicit cross-session ids AND lets the agent call
      // with just a mark_id.
      let ctx: SessionContext | undefined;
      if (typeof input.tab_id === 'string' && input.tab_id) {
        const sid = sessionForTab(input.tab_id);
        ctx = sid ? contexts.get(sid) : undefined;
        if (!ctx || ctx.status !== 'live' || ctx.sessionId !== activeSessionId) {
          return { error_reason: 'wrong_session', hint: 'That tab_id is not part of the active studio session.' };
        }
      } else {
        ctx = targetContext();
        if (!ctx) return noActive();
      }
      ctx.lastActiveAt = Date.now();
      try {
        return await ctx.extractSet(input);
      } catch {
        return { error_reason: 'extract_unavailable', hint: 'The local library service is not available — extraction cannot run right now.' };
      }
    },
  };

  const sessions: StudioSessionsAccessor = {
    getSessionDrive: (id: string): SessionDrive | undefined => {
      const c = contexts.get(id);
      return c && c.status === 'live' ? c.drive : undefined;
    },
  };

  return {
    handlers,
    sessions,
    onHumanInput(tabId: string): void {
      const sessionId = sessionForTab(tabId);
      if (!sessionId) return;
      const ctx = contexts.get(sessionId);
      if (ctx && ctx.status === 'live') ctx.tab.drive.fsm.onHumanInput();
    },
    // §13.8c: mutate the active session's shared NavGrant (read pull-at-eval by NavInterceptor + act.ts's
    // navigate → effective on the very next hop, no re-arm window). guardNavigation still hard-blocks
    // link_local/cloud-metadata BEFORE the allowPrivate check, so this can never open cloud-internal.
    grantLocalhost(): boolean {
      const ctx = targetContext();
      if (!ctx) return false;
      ctx.tab.drive.grant.agentAllowPrivate = true;
      return true;
    },
    revokeLocalhost(): boolean {
      const ctx = targetContext();
      if (!ctx) return false;
      ctx.tab.drive.grant.agentAllowPrivate = false;
      return true;
    },
    localhostGranted(): boolean {
      return targetContext()?.tab.drive.grant.agentAllowPrivate ?? false;
    },
    getActiveSessionId(): string | null {
      return activeSessionId;
    },
    resolveApproval(approvalId: string, decision: 'allow' | 'deny'): void {
      const rec = parked.get(approvalId);
      if (!rec) return;
      parked.delete(approvalId);
      const ctx = contexts.get(rec.sessionId);
      if (!ctx || ctx.status === 'closed') return;
      // S9/D9 authenticated-use card: settle the BLOCKED navigation. ALLOW records the origin on the same
      // per-session pre-grant store the action grants use, so the card fires once per origin per session,
      // and the store keeps its human-only writer — this call is only ever the human's card click.
      if (rec.authenticatedUse) {
        if (decision === 'allow') ctx.preGrant.allowAuthenticatedUse(rec.authenticatedUse.origin);
        rec.authenticatedUse.settle(decision === 'allow' ? 'approved' : 'refused');
        ctx.eventQueue.enqueue({ type: 'approval', approval_id: approvalId, decision });
        return;
      }
      // ALLOW adds a matching pre-grant so the agent's re-issued act passes the risk gate; DENY adds none.
      // Either way the decision rides the next studio_observe drain. Never auto-allowed — this is only ever
      // called from the human's card click.
      if (decision === 'allow' && rec.domain) {
        ctx.preGrant.add({ domain: rec.domain, actionType: rec.actionType, riskTier: rec.riskTier });
      }
      ctx.eventQueue.enqueue({ type: 'approval', approval_id: approvalId, decision });
    },
    async markElement({ tabId, path, payload }): Promise<MarkCreated | StudioToolError> {
      const sid = sessionForTab(tabId);
      const ctx = sid ? contexts.get(sid) : undefined;
      if (!ctx || ctx.status !== 'live') return { error_reason: 'no_active_session', hint: 'That tab has no live session.' };
      // DR-1: an empty path would resolve to <html> — never a real mark intent (e.g. a shadow-broken path).
      if (path.length === 0) return { error_reason: 'mark_unresolved', hint: 'That element could not be resolved (empty path — likely a shadow boundary).' };
      // Credential-arc: NEVER resolve or STORE a mark made on a credential context — the element's role/name
      // can be a displayed secret (a 2FA/recovery code). Refusing at CREATION is what makes it un-leakable:
      // a current-page-only exclusion on the pull path (marksView) still leaks a stored credential mark once
      // the page leaves the credential context. Nothing is stored, so nothing can surface to the agent later.
      if (await ctx.isCredentialPage()) return { error_reason: 'credential_context', hint: 'Marking is disabled on login/credential pages (a marked element there can be a displayed secret).' };
      const target = await ctx.resolvePicked(path);
      if (!target) return { error_reason: 'mark_unresolved', hint: 'That element could not be resolved on the current page.' };
      const mark = ctx.markStore.add(target);
      ctx.payloads.set(mark.markId, payload);
      const role = neutralizeMarkers(target.role);
      const name = neutralizeMarkers(target.name);
      // Not on a credential page (guarded above) → surface the neutralized mark event for studio_observe.
      ctx.eventQueue.enqueue({ type: 'mark', tab_id: tabId, markId: mark.markId, role, name, trusted: false });
      // Write-through persist (P3): the mark also lands in the local library (type='mark'). Fire-and-forget
      // + error-swallowed — a persistence miss must NEVER break the in-memory mark loop (P2's proven path).
      // Guarded non-credential above; the fresh signal still gives the broker its own defense. Detached so
      // markElement returns without awaiting the extra snapshot.
      void (async () => {
        try {
          await deps.broker.call('persistMark', { sessionId: ctx.sessionId, url: ctx.tab.currentUrl(), target, credentialSignal: await ctx.credentialSignal() });
        } catch { /* persist miss ≠ mark failure */ }
      })();
      return { markId: mark.markId, role, name };
    },
    async postHumanChat(text: string): Promise<void> {
      const ctx = targetContext();
      if (!ctx) return;
      const t = typeof text === 'string' ? text.trim() : '';
      if (!t) return;
      // Credential-gated at source (mirrors addComment): a chat message typed on a login page could quote a
      // secret. Dropped, not buffered. Human chat is a trusted human→agent instruction (trusted:true).
      if (await ctx.isCredentialPage()) return;
      ctx.eventQueue.enqueue({ type: 'chat', tab_id: ctx.tab.tabId, text: t, author: 'human', trusted: true });
    },
    async addComment({ markId, text }): Promise<{ ok: true } | StudioToolError> {
      const ctx = targetContext();
      if (!ctx) return { error_reason: 'no_active_session', hint: 'No session is open.' };
      if (!ctx.markStore.get(markId)) return { error_reason: 'no_such_mark', hint: 'That mark id is not in the current session.' };
      const list = ctx.comments.get(markId) ?? [];
      list.push({ text, author: 'human', ts: Date.now() });
      ctx.comments.set(markId, list);
      // DR-3: human comment text is trusted (a legitimate human→agent instruction), passes raw with
      // trusted:true — but still credential-gated at source (a comment on a login screen may quote a secret).
      if (!(await ctx.isCredentialPage())) {
        ctx.eventQueue.enqueue({ type: 'comment', tab_id: ctx.tab.tabId, markId, text, author: 'human', trusted: true });
        // Write-through persist (P3): a human comment lands as a note (type='note', content_trusted=1).
        void (async () => {
          try { await deps.broker.call('persistComment', { sessionId: ctx.sessionId, text }); } catch { /* persist miss ≠ comment failure */ }
        })();
      }
      return { ok: true };
    },
    async captureQuote(tabId: string, quote: QuoteMsg): Promise<StudioCaptureOutput | StudioToolError> {
      const sid = sessionForTab(tabId);
      const ctx = sid ? contexts.get(sid) : undefined;
      if (!ctx || ctx.status !== 'live') return { error_reason: 'no_active_session', hint: 'That tab has no live session.' };
      // Credential-gated at source (mirrors markElement/addComment): a quote on a login page can be a secret.
      if (await ctx.isCredentialPage()) return { error_reason: 'credential_context', hint: 'Quote capture is disabled on login/credential pages.' };
      try {
        return await deps.broker.call<StudioCaptureOutput | StudioToolError>('capture', {
          input: { type: 'clip', content: `> ${quote.text}\n\n${quote.context}`, url: quote.url },
          sessionId: ctx.sessionId,
          currentNavEpoch: ctx.currentNavEpoch(),
          lastObserveEpoch: ctx.lastObserveEpoch(),
          credentialSignal: await ctx.credentialSignal(),
        });
      } catch {
        return { error_reason: 'capture_unavailable', hint: 'The local library service is not available right now.' };
      }
    },
    async captureRegion(tabId: string, rect: RegionMsg['rect']): Promise<StudioCaptureOutput | StudioToolError> {
      const sid = sessionForTab(tabId);
      const ctx = sid ? contexts.get(sid) : undefined;
      if (!ctx || ctx.status !== 'live') return { error_reason: 'no_active_session', hint: 'That tab has no live session.' };
      if (!deps.capturePage) return { error_reason: 'capture_unavailable', hint: 'Region capture is not available in this build.' };
      // Fail-CLOSED on a credential context BEFORE any pixel capture or disk write — a screenshot of a
      // login/2FA page must never be taken or persisted (isCredentialContext inspects url+fields, not
      // pixels, so this host gate is the real guard; the broker re-gates on the same signal too).
      if (await ctx.isCredentialPage()) return { error_reason: 'credential_context', hint: 'Region capture is disabled on login/credential pages.' };
      try {
        const shot = await deps.capturePage(tabId, rect);
        const contentHash = createHash('sha256').update(shot.png).digest('hex');
        // sessionId is a randomUUID — assert it before it becomes a path segment (traversal belt).
        if (!/^[0-9a-f-]{36}$/i.test(ctx.sessionId)) throw new Error('invalid session id for media path');
        const mediaPath = join(mediaRoot, ctx.sessionId, `${contentHash}.png`);
        // Write the PNG BEFORE the DB row so the row's mediaPath NEVER dangles: a persist failure then
        // leaves at worst a harmless orphan FILE (hash-named → idempotent), never a row pointing at nothing.
        // Skip the write if the content is already on disk (dedup — same hash = same bytes).
        if (!existsSync(mediaPath)) {
          await mkdir(dirname(mediaPath), { recursive: true });
          await writeFile(mediaPath, shot.png);
        }
        const r = await deps.broker.call<CaptureResult>('persistScreenshot', {
          sessionId: ctx.sessionId, url: shot.url, title: shot.title, mediaPath, contentHash,
          credentialSignal: await ctx.credentialSignal(),
        });
        return { artifact_id: r.id, inserted: r.inserted, content_hash: r.contentHash };
      } catch {
        return { error_reason: 'capture_unavailable', hint: 'The local library service is not available right now.' };
      }
    },
    async listMarks(): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError> {
      const ctx = targetContext();
      if (!ctx) return { error_reason: 'no_active_session', hint: 'No session is open.' };
      return ctx.marksTool({});
    },
    async listCaptures(): Promise<CaptureDto[]> {
      const ctx = targetContext();
      if (!ctx) return [];
      try {
        const rows = await deps.broker.call<Array<{ id: number; type: string; title: string | null; url: string | null; trusted: boolean; created_at: string }>>(
          'listArtifacts', { sessionId: ctx.sessionId, limit: 200 },
        );
        return rows.map((r) => ({ id: r.id, type: r.type, title: r.title, url: r.url, trusted: r.trusted, createdAt: r.created_at }));
      } catch { return []; } // broker down → the panel shows nothing rather than erroring
    },
    async listAudit(): Promise<AuditDto[]> {
      const ctx = targetContext();
      if (!ctx) return [];
      try {
        const rows = await deps.broker.call<AuditEntry[]>('listAudit', { sessionId: ctx.sessionId, limit: 200 });
        return rows.map(auditToWire);
      } catch { return []; } // broker down → the timeline degrades to empty, never errors the UI
    },
    async synthesizeSession(): Promise<ResearchBriefDto> {
      const ctx = targetContext();
      if (!ctx) return { empty: true };
      try {
        return await deps.broker.call<ResearchBriefDto>('synthesizeSession', { sessionId: ctx.sessionId });
      } catch { return { empty: true }; } // broker down → honest empty, never errors the UI
    },
    async knowledgeSimilar(concept: string): Promise<KnowledgeHit[]> {
      if (!concept.trim()) return [];
      try {
        const out = await deps.broker.call<{ results?: Array<{ url: string; title: string; relevance_score: number; source: string }> }>(
          'findSimilar', { input: { concept, include_web: false, include_cache: true, max_results: 3 } },
        );
        return (out.results ?? []).map((r) => ({ url: r.url, title: r.title, score: r.relevance_score, source: r.source }));
      } catch { return []; } // broker down → the rail degrades quietly (never errors the UI)
    },
    async shutdown(): Promise<void> {
      for (const ctx of contexts.values()) {
        if (ctx.status !== 'live') continue;
        ctx.status = 'closed';
        try {
          deps.closeTab(ctx.tab.tabId); // detaches the CDP transport + destroys the WebContentsView
        } catch { /* best-effort teardown */ }
        // The host is going away; the run is not finished, it is cancelled. Best-effort, because a
        // shutdown that hangs on a store write is worse than a run whose last event lands late.
        const runId = deps.runs.runForSession(ctx.sessionId);
        if (runId) {
          try {
            await deps.runs.endRun(runId, 'cancelled');
          } catch { /* best-effort teardown */ }
        }
      }
      contexts.clear();
      parked.clear();
      actChains.clear();
      activeSessionId = null;
    },
  };
}
