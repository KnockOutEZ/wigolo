export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface StudioState {
  sessionName: string;
  tabs: TabInfo[];
}

/** A parked risky agent action awaiting the human's Allow/Deny in the approval card (P1 placeholder). */
export interface PendingApprovalDto {
  id: string;
  action: string;
  risk: 'money' | 'credential' | 'destructive';
}

// renderer → main
export const IPC = {
  tabCreate: 'studio:tab-create',
  tabClose: 'studio:tab-close',
  tabFocus: 'studio:tab-focus',
  tabNavigate: 'studio:tab-navigate',
  getState: 'studio:get-state',
  approvalDecide: 'studio:approval-decide',
  // main → renderer
  stateChanged: 'studio:state-changed',
  approvalParked: 'studio:approval-parked',
} as const;
