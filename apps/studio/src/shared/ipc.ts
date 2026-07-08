import type { MarkPayload, QuotePayload } from '../preload/overlay-core';

/** overlay(tab) → main: the human captured a text selection as a cited quote (⌘⇧C). */
export type QuoteMsg = QuotePayload;

/** overlay(tab) → main: the human dragged a rectangle to clip a region (screenshot). Client-space CSS px. */
export interface RegionMsg {
  rect: { x: number; y: number; width: number; height: number };
}

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

/** main → renderer: one captured item for the Captures rail pane (light projection — no body). */
export interface CaptureDto {
  id: number;
  type: string;
  title: string | null;
  url: string | null;
  trusted: boolean;
  createdAt: string;
}

/**
 * main → renderer: one agent action for the Timeline rail pane (P6 F4). Metadata + a host-derived summary
 * ONLY — page-text-free by construction (M3): the agent's verb, the host-assigned ref/direction/amount, the
 * origin-only url, the risk tier + resolved outcome + approval. `screenshotId` links a step to its captured
 * screenshot when one exists (F4.6). This is the shape the host's auditToWire emits + listAudit returns.
 */
export interface AuditDto {
  seq: number;
  action: string;
  url?: string;
  ref?: string;
  direction?: 'up' | 'down';
  amount?: number;
  risk?: string;
  ok: boolean;
  error_reason?: string;
  charsLanded?: number;
  approval?: string;
  ts: number;
  screenshotId?: number;
}

/** A knowledge-rail hit: a related item from the local studio corpus (find_similar on the current page). */
export interface KnowledgeHit {
  url: string;
  title: string;
  score: number;
  /** 'studio' = a captured session artifact; 'cache' = a fetched page. */
  source: string;
}

/** A parked risky agent action awaiting the human's Allow/Deny in the approval card (P1 placeholder). */
export interface PendingApprovalDto {
  id: string;
  action: string;
  risk: 'money' | 'credential' | 'destructive';
}

/** main → renderer(chrome): a per-tab drive event for the drive banner / provenance dots / narration. */
export interface DriveEventDto {
  tabId: string;
  t: 'control' | 'act';
  holder?: 'human' | 'agent';
  epoch?: number;
  action?: string;
  /** Agent-authored per-act intent (spec §5 "note"). Page-independent, agent-trusted — never page-derived. */
  narration?: string;
}

/** main → overlay(tab): move/show the ghost cursor at a viewport point with a caption (agent driving). */
export interface OverlayCursorMsg { x: number; y: number; caption: string }

/** A chat rail message — the agent via studio_say, or the human's composer. Agent text renders inert. */
export interface ChatMsgDto { author: 'agent' | 'human'; text: string; markId?: string; ts: number }

/** main → renderer: the agent's localhost/private-net grant state for the active session (§13.8c). */
export interface GrantStateDto { granted: boolean }

/** main → renderer: the active session changed (open/close) — the renderer re-backfills per-session UI. */
export interface SessionChangedDto { sessionId: string | null }

// renderer → main
export const IPC = {
  tabCreate: 'studio:tab-create',
  tabClose: 'studio:tab-close',
  tabFocus: 'studio:tab-focus',
  tabNavigate: 'studio:tab-navigate',
  getState: 'studio:get-state',
  approvalDecide: 'studio:approval-decide',
  setRailOpen: 'studio:set-rail-open',
  // P4 co-drive: human seams (Electron-IPC only — never the agent gateway)
  driveReclaim: 'studio:drive-reclaim',
  armClip: 'studio:arm-clip',
  setBannerOpen: 'studio:set-banner-open',
  chatSend: 'studio:chat-send',
  grantLocalhost: 'studio:grant-localhost',
  revokeLocalhost: 'studio:revoke-localhost',
  // overlay(tab) → main
  overlayMark: 'studio:overlay-mark',
  overlayGeneralize: 'studio:overlay-generalize',
  overlayQuote: 'studio:overlay-quote',
  overlayRegion: 'studio:overlay-region',
  // main → overlay(tab)
  overlayArm: 'studio:overlay-arm',
  overlayMarkAssigned: 'studio:overlay-mark-assigned',
  overlayCursor: 'studio:overlay-cursor',
  clipArm: 'studio:clip-arm',
  // renderer(chrome) → main
  armMarkMode: 'studio:arm-mark-mode',
  markComment: 'studio:mark-comment',
  markGeneralize: 'studio:mark-generalize',
  extractSet: 'studio:extract-set',
  listCaptures: 'studio:list-captures',
  listAudit: 'studio:list-audit',
  synthesize: 'studio:synthesize',
  knowledgeSimilar: 'studio:knowledge-similar',
  // main → renderer
  stateChanged: 'studio:state-changed',
  approvalParked: 'studio:approval-parked',
  marksChanged: 'studio:marks-changed',
  generalizePreview: 'studio:generalize-preview',
  captureAdded: 'studio:capture-added',
  auditEntry: 'studio:audit-entry',
  driveEvent: 'studio:drive-event',
  chatMessage: 'studio:chat-message',
  grantState: 'studio:grant-state',
  sessionChanged: 'studio:session-changed',
  loginHandoff: 'studio:login-handoff',
} as const;
