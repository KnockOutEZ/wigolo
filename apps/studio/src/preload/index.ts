import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type StudioState, type PendingApprovalDto, type MarkDto, type CaptureDto, type KnowledgeHit, type DriveEventDto } from '../shared/ipc';
import type { StudioGeneralizeOutput } from 'wigolo/studio';

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
};

export type StudioApi = typeof studio;
contextBridge.exposeInMainWorld('studio', studio);
