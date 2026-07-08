import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type StudioState, type PendingApprovalDto, type MarkDto, type CaptureDto, type KnowledgeHit, type DriveEventDto, type ChatMsgDto, type GrantStateDto, type SessionChangedDto, type AuditDto } from '../shared/ipc';
import type { StudioGeneralizeOutput, ResearchBriefDto } from 'wigolo/studio';

const studio = {
  getState: (): Promise<StudioState> => ipcRenderer.invoke(IPC.getState),
  createTab: (url: string): Promise<string> => ipcRenderer.invoke(IPC.tabCreate, url),
  closeTab: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabClose, id),
  focusTab: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabFocus, id),
  navigate: (id: string, url: string): Promise<void> => ipcRenderer.invoke(IPC.tabNavigate, id, url),
  onState: (cb: (s: StudioState) => void): void => {
    ipcRenderer.on(IPC.stateChanged, (_e, s: StudioState) => cb(s));
  },
  onApprovalParked: (cb: (a: PendingApprovalDto) => void): void => {
    ipcRenderer.on(IPC.approvalParked, (_e, a: PendingApprovalDto) => cb(a));
  },
  decideApproval: (id: string, decision: 'allow' | 'deny'): Promise<void> => ipcRenderer.invoke(IPC.approvalDecide, id, decision),
  setRailOpen: (open: boolean): Promise<void> => ipcRenderer.invoke(IPC.setRailOpen, open),
  // ── P2 marking ──
  /** Arm the focused tab's marking overlay (toolbar ◈ / ⌘M). */
  armMarkMode: (): void => { ipcRenderer.send(IPC.armMarkMode); },
  /** P6 F1 grab-all: extract a marked repeating pattern into structured rows (the result lands as a captures card). */
  extractSet: (input: { tab_id: string; mark_id: string; exclude_refs?: string[]; follow_pagination?: boolean }): void => { ipcRenderer.send(IPC.extractSet, input); },
  /** Live marks for the rail (host push after every human mark/comment). */
  onMarksChanged: (cb: (marks: MarkDto[]) => void): void => {
    ipcRenderer.on(IPC.marksChanged, (_e, marks: MarkDto[]) => cb(marks));
  },
  /** Pin a human comment on a mark (stored + surfaced to the agent via studio_observe). */
  addComment: (markId: string, text: string): Promise<{ ok: true } | { error_reason: string; hint: string }> =>
    ipcRenderer.invoke(IPC.markComment, markId, text),
  /** Preview the repeating set a mark belongs to (confirm-gated; never acts). */
  generalize: (markId: string): Promise<StudioGeneralizeOutput | { error_reason: string; hint: string }> =>
    ipcRenderer.invoke(IPC.markGeneralize, markId),
  /** A generalize preview pushed from a tab's ⧉ action-bar button. */
  onGeneralizePreview: (cb: (preview: StudioGeneralizeOutput) => void): void => {
    ipcRenderer.on(IPC.generalizePreview, (_e, p: StudioGeneralizeOutput) => cb(p));
  },
  // ── P3 capture ──
  /** The active session's captured items (Captures rail; on session open). */
  listCaptures: (): Promise<CaptureDto[]> => ipcRenderer.invoke(IPC.listCaptures),
  /** A newly captured item pushed live (agent clip / human quote / region screenshot). */
  onCaptureAdded: (cb: (c: CaptureDto) => void): void => {
    ipcRenderer.on(IPC.captureAdded, (_e, c: CaptureDto) => cb(c));
  },
  /** find_similar on the current page against the local studio corpus (knowledge rail). */
  knowledgeSimilar: (concept: string): Promise<KnowledgeHit[]> => ipcRenderer.invoke(IPC.knowledgeSimilar, concept),
  /** P6 F3: synthesize the session's captured artifacts into a research brief (or an honest empty state). */
  synthesize: (): Promise<ResearchBriefDto> => ipcRenderer.invoke(IPC.synthesize),
  // ── P6 F4 timeline ──
  /** The active session's audit trail (Timeline rail; on session open + per-session reset). */
  listAudit: (): Promise<AuditDto[]> => ipcRenderer.invoke(IPC.listAudit),
  /** A newly recorded agent action pushed live (page-text-free summary). */
  onAuditEntry: (cb: (e: AuditDto) => void): void => {
    ipcRenderer.on(IPC.auditEntry, (_e, dto: AuditDto) => cb(dto));
  },
  // ── P4 co-drive ──
  /** Per-tab drive events (control flips + agent acts) for the drive banner, provenance dots, and narration. */
  onDriveEvent: (cb: (e: DriveEventDto) => void): void => {
    ipcRenderer.on(IPC.driveEvent, (_e, d: DriveEventDto) => cb(d));
  },
  /** Human hit Pause / take-over on the drive banner → preempt the agent on this tab (explicit human signal). */
  reclaimDrive: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.driveReclaim, tabId),
  /** Toolbar ✂ → arm region-clip on the focused session tab (same gesture as ⌘⇧X). */
  armClip: (): void => { ipcRenderer.send(IPC.armClip); },
  /** Tell main the drive banner is shown/hidden so it insets the WebContentsView stage (like the rail). */
  setBannerOpen: (open: boolean): Promise<void> => ipcRenderer.invoke(IPC.setBannerOpen, open),
  /** A chat message from the agent (studio_say) arriving live for the chat rail. */
  onChatMessage: (cb: (m: ChatMsgDto) => void): void => {
    ipcRenderer.on(IPC.chatMessage, (_e, m: ChatMsgDto) => cb(m));
  },
  /** The human typed in the chat composer → deliver it to the agent (drained in its next studio_observe). */
  sendChat: (text: string): void => { ipcRenderer.send(IPC.chatSend, text); },
  /** §13.8c: allow / revoke the agent on localhost + private-network pages for the active session. */
  grantLocalhost: (): Promise<boolean> => ipcRenderer.invoke(IPC.grantLocalhost),
  revokeLocalhost: (): Promise<boolean> => ipcRenderer.invoke(IPC.revokeLocalhost),
  /** The agent's localhost-grant state for the active session (pushed on grant/revoke/session change). */
  onGrantState: (cb: (g: GrantStateDto) => void): void => {
    ipcRenderer.on(IPC.grantState, (_e, g: GrantStateDto) => cb(g));
  },
  /** The active session changed (open/close) — re-backfill captures + reset per-session UI. */
  onSessionChanged: (cb: (s: SessionChangedDto) => void): void => {
    ipcRenderer.on(IPC.sessionChanged, (_e, s: SessionChangedDto) => cb(s));
  },
  /** P5: the login-wall handoff state (in_progress / completed / failed) for the login card. Only {state, origin?}. */
  onLoginHandoff: (cb: (msg: { sessionId: string; state: 'in_progress' | 'completed' | 'failed'; origin?: string }) => void): void => {
    ipcRenderer.on(IPC.loginHandoff, (_e, msg) => cb(msg));
  },
};

export type StudioApi = typeof studio;
contextBridge.exposeInMainWorld('studio', studio);
