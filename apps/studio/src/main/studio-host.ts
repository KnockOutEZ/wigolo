import { randomUUID } from 'node:crypto';
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
  resolveNodePath,
  neutralizeMarkers,
  isCredentialContext,
  UNTRUSTED_STUDIO_NOTICE,
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
  type StudioCaptureOutput,
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
  /**
   * Stand up a driven tab for a new session (host-side: create WebContentsView + await driveEngine.attachTab).
   * The tab MUST come back with its SSRF/redirect fence already armed and loaded to a SAFE blank page — the
   * agent's requested startUrl is navigated separately through the GATED path, never a raw ungated load.
   */
  createTab: (opts: { initialHolder: ControlParty; grant: NavGrant }) => HostTab | Promise<HostTab>;
  /** Tear a session's tab down. */
  closeTab: (tabId: string) => void;
  /** Surface a parked risky act to the human approval card (never auto-allowed). */
  onParked: (notice: ParkedApprovalNotice) => void;
  config?: StudioHostConfig;
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
  /** The active session's marks for the rail (host-internal mirror of studio_marks list). */
  listMarks(): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError>;
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
  /** studio_marks: list (heal each mark) | generalize a mark (preview). Credential-excluded. */
  marksTool: (input: StudioMarksInput) => Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError>;
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
  // HOST-WIDE mark id sequence so ids are unique across concurrent sessions — a stale cross-session
  // markId then resolves to nothing (clean no_such_mark) instead of silently hitting another session's `m1`.
  let markSeq = 0;
  const mintMarkId = (): string => 'm' + ++markSeq;

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

    // The shared credential-context probe — the SAME one observe uses; drives both the pull-path
    // exclusion (marksView) and the push-path drop-at-source (markElement/addComment enqueue).
    const isCredentialPage = async (): Promise<boolean> => {
      const snap = await snapshot();
      return isCredentialContext({ pageUrl: tab.currentUrl(), fields: snap.domByRef?.values() });
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
      act,
      drive,
      markStore,
      payloads,
      comments,
      resolvePicked,
      isCredentialPage,
      marksTool,
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
    const tab = await deps.createTab({ initialHolder: 'agent', grant });
    const ctx = buildContext(sessionId, name, tab);
    contexts.set(sessionId, ctx);
    tabToSession.set(tab.tabId, sessionId);
    activeSessionId = sessionId;
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
      // Reclaim every map keyed on this session — else a long-lived host leaks a full SessionContext
      // (+ its snapshotter/queue/closures) and any never-resolved parked approval, per open/close cycle.
      for (const [aid, rec] of parked) if (rec.sessionId === id) parked.delete(aid);
      contexts.delete(id);
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
    async markElement({ tabId, path, payload }): Promise<MarkCreated | StudioToolError> {
      const sid = tabToSession.get(tabId);
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
      return { markId: mark.markId, role, name };
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
      }
      return { ok: true };
    },
    async listMarks(): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError> {
      const ctx = targetContext();
      if (!ctx) return { error_reason: 'no_active_session', hint: 'No session is open.' };
      return ctx.marksTool({});
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
      parked.clear();
      actChains.clear();
      activeSessionId = null;
    },
  };
}
