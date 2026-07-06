import { randomUUID } from 'node:crypto';
import {
  PageSnapshotter,
  createResolver,
  createObserver,
  createActHandler,
  createSessionDrive,
  PreGrantStore,
  StudioEventQueue,
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
  type StudioMarksOutput,
  type StudioCaptureOutput,
  type ControlParty,
  type NavGrant,
  type NavigableBrowser,
  type ParkedAction,
  type RiskTier,
} from 'wigolo/studio';
import type { TabDrive } from './drive-engine';

// The Electron main process IS the studio session host (spec §2). This module composes
// the salvaged domain layer (perception → observe, act, session-drive) over the per-tab
// CDP transport the drive engine stood up — the exact wiring src/cli/studio.ts did over
// the Playwright backend, but in-process against webContents.debugger. It hands the MCP
// gateway a StudioHostHandlers + a StudioSessionsAccessor (D19). Marking (P2) and capture
// (P3) return an explicit not_implemented StageResult — never a silent stub.

const DEFAULT_INLINE_BUDGET = 6000;
const DEFAULT_SPILL_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_SESSION_CAP = 8;

export type ApprovalRisk = 'money' | 'credential' | 'destructive';

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
}

export interface StudioHostConfig {
  sessionCap?: number;
  inlineBudget?: number;
  spillMaxBytes?: number;
  dataDir?: string;
}

export interface StudioHostDeps {
  /** Stand up a driven tab for a new session (host-side: create WebContentsView + driveEngine.attachTab). */
  createTab: (opts: { startUrl?: string; initialHolder: ControlParty; grant: NavGrant }) => HostTab | Promise<HostTab>;
  /** Tear a session's tab down. */
  closeTab: (tabId: string) => void;
  /** Surface a parked risky act to the human approval card (never auto-allowed). */
  onParked: (notice: ParkedApprovalNotice) => void;
  config?: StudioHostConfig;
}

export interface StudioHost {
  handlers: StudioHostHandlers;
  sessions: StudioSessionsAccessor;
  /** Native human input landed on a tab → preempt the agent instantly (fsm → paused). */
  onHumanInput(tabId: string): void;
  /** The human's Allow/Deny from the approval card. Allow adds the matching pre-grant; both drain in the next observe. */
  resolveApproval(approvalId: string, decision: 'allow' | 'deny'): void;
  /** Cleanly detach every session's tab (app quit). */
  shutdown(): Promise<void>;
}

interface ParkedRecord {
  approvalId: string;
  sessionId: string;
  domain: string | undefined;
  actionType: string;
  riskTier: RiskTier;
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

  const contexts = new Map<string, SessionContext>();
  const tabToSession = new Map<string, string>();
  const parked = new Map<string, ParkedRecord>();
  let activeSessionId: string | null = null;

  // Serialize acts per session so the park-id correlation window (park callback → return) cannot
  // interleave with a second concurrent act on the same session.
  const actChains = new Map<string, Promise<unknown>>();

  function buildContext(sessionId: string, name: string, tab: HostTab): SessionContext {
    const transport = tab.drive.transport;
    const snapshotter = new PageSnapshotter({ tokenBudget: inlineBudget });
    const snapshot = () => snapshotter.snapshot(transport);
    const resolve = createResolver({ snapshot, cdp: transport });
    const eventQueue = new StudioEventQueue(512);
    const preGrant = new PreGrantStore();

    const observe = createObserver({
      snapshot,
      eventQueue,
      inlineBudget,
      spillMaxBytes,
      dataDir: cfg.dataDir,
      currentUrl: tab.currentUrl,
      markObserved: () => tab.drive.navEpoch.markObserved(),
    });

    // A container reset via a FUNCTION call (not a direct `= undefined`, which would let control-flow
    // analysis narrow the property to `undefined` and collapse the truthy check to `never`). The park
    // callback writes `rec` synchronously inside the awaited actHandler call, which flow analysis of a
    // plain local cannot see — the opaque reset keeps the read typed `ParkedRecord | undefined`.
    const parkBox: { rec: ParkedRecord | undefined } = { rec: undefined };
    const clearPark = (): void => { parkBox.rec = undefined; };
    const actHandler = createActHandler({
      browser: tab.browser,
      controlToken: tab.drive.controlToken,
      grant: tab.drive.grant,
      resolve,
      channel: tab.drive.channel,
      currentUrl: tab.currentUrl,
      preGrant,
      park: (item: ParkedAction) => {
        const approvalId = randomUUID();
        const rec: ParkedRecord = { approvalId, sessionId, domain: item.domain, actionType: item.action, riskTier: item.risk };
        parkBox.rec = rec;
        parked.set(approvalId, rec);
        deps.onParked({ approval_id: approvalId, action: item.action, risk: item.risk as ApprovalRisk, session_id: sessionId });
      },
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
      // P3 wires the real cache capture; until then a session-targeted fetch that would persist
      // fails CLOSED (never silently drops content). CaptureRefusedError only carries the two
      // salvaged reason literals, so a P1 stub raises a plain, explicit error instead.
      insert: async () => {
        throw new Error('studio session capture is not available yet (arrives in a later release)');
      },
    });

    return {
      sessionId,
      name,
      tab,
      preGrant,
      eventQueue,
      observe,
      act,
      drive,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      status: 'live',
    };
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
    const tab = await deps.createTab({ startUrl: input.startUrl, initialHolder: 'agent', grant });
    const ctx = buildContext(sessionId, name, tab);
    contexts.set(sessionId, ctx);
    tabToSession.set(tab.tabId, sessionId);
    activeSessionId = sessionId;
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
    marks: async () => notImplemented('Marking', 'P2') as StudioMarksOutput | StudioToolError,
    capture: async () => notImplemented('Capture', 'P3') as StudioCaptureOutput | StudioToolError,
    spawn: open,
    close: async (input: StudioCloseInput): Promise<StudioCloseOutput | StudioToolError> => {
      const id = typeof input.session_id === 'string' ? input.session_id : '';
      const ctx = contexts.get(id);
      if (!ctx || ctx.status === 'closed') {
        return { error_reason: 'no_such_session', hint: 'That session is unknown or already closed.' };
      }
      ctx.status = 'closed';
      deps.closeTab(ctx.tab.tabId);
      tabToSession.delete(ctx.tab.tabId);
      actChains.delete(id);
      if (activeSessionId === id) activeSessionId = targetContext()?.sessionId ?? null;
      return { closed: true, session_id: id };
    },
    list: async (): Promise<StudioListOutput> => ({
      sessions: [...contexts.values()].map((c) => ({
        id: c.sessionId,
        status: c.status,
        clients: 0,
        createdAt: c.createdAt,
        lastActiveAt: c.lastActiveAt,
      })),
    }),
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
      const sessionId = tabToSession.get(tabId);
      if (!sessionId) return;
      const ctx = contexts.get(sessionId);
      if (ctx && ctx.status === 'live') ctx.tab.drive.fsm.onHumanInput();
    },
    resolveApproval(approvalId: string, decision: 'allow' | 'deny'): void {
      const rec = parked.get(approvalId);
      if (!rec) return;
      parked.delete(approvalId);
      const ctx = contexts.get(rec.sessionId);
      if (!ctx || ctx.status === 'closed') return;
      // ALLOW adds a matching pre-grant so the agent's re-issued act passes the risk gate; DENY adds none.
      // Either way the decision rides the next studio_observe drain. Never auto-allowed — this is only ever
      // called from the human's card click.
      if (decision === 'allow' && rec.domain) {
        ctx.preGrant.add({ domain: rec.domain, actionType: rec.actionType, riskTier: rec.riskTier });
      }
      ctx.eventQueue.enqueue({ type: 'approval', approval_id: approvalId, decision });
    },
    async shutdown(): Promise<void> {
      for (const ctx of contexts.values()) {
        if (ctx.status !== 'live') continue;
        ctx.status = 'closed';
        try {
          deps.closeTab(ctx.tab.tabId); // detaches the CDP transport + destroys the WebContentsView
        } catch { /* best-effort teardown */ }
      }
      contexts.clear();
      tabToSession.clear();
    },
  };
}
