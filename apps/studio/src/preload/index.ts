import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type StudioState, type PendingApprovalDto } from '../shared/ipc';

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
};

export type StudioApi = typeof studio;
contextBridge.exposeInMainWorld('studio', studio);
