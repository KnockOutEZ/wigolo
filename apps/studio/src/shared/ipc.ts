import type { MarkPayload } from '../preload/overlay-core';

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** overlay(tab) → main: the human committed a mark. `path` is element-child indices from documentElement. */
export interface OverlayMarkMsg {
  nonce: string;
  path: number[];
  payload: MarkPayload;
}

/** main → renderer: one mark for the Marks rail pane. role/name are page-derived (untrusted, host-neutralized). */
export interface MarkDto {
  markId: string;
  role: string;
  name: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  ref?: string;
}

/** renderer → main → overlay echo: assigns the committed mark its number + id (chip stamp). */
export interface MarkAssignedDto {
  nonce: string;
  markId: string;
  number: number;
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
  setRailOpen: 'studio:set-rail-open',
  // overlay(tab) → main
  overlayMark: 'studio:overlay-mark',
  overlayGeneralize: 'studio:overlay-generalize',
  // main → overlay(tab)
  overlayArm: 'studio:overlay-arm',
  overlayMarkAssigned: 'studio:overlay-mark-assigned',
  // renderer(chrome) → main
  armMarkMode: 'studio:arm-mark-mode',
  markComment: 'studio:mark-comment',
  markGeneralize: 'studio:mark-generalize',
  // main → renderer
  stateChanged: 'studio:state-changed',
  approvalParked: 'studio:approval-parked',
  marksChanged: 'studio:marks-changed',
  generalizePreview: 'studio:generalize-preview',
} as const;
