import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type StudioState, type PendingApprovalDto, type MarkDto } from '../shared/ipc';
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
};

export type StudioApi = typeof studio;
contextBridge.exposeInMainWorld('studio', studio);
