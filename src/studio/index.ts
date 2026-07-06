// Barrel for the Wigolo Studio domain layer consumed by the Electron app
// (apps/studio) via the `wigolo/studio` exports subpath. Salvaged domain code
// stays in core src/studio and is imported by the app's main process — see
// docs/superpowers/specs/2026-07-06-studio-browser-overhaul-design.md §2.
//
// Explicit re-exports (not `export *`) keep the public surface intentional and
// avoid cross-module type-name collisions. This barrel grows per P1 task as the
// app wires each seam (act/observe/nav/session-control/session-drive land with
// their consuming tasks, verified against source at that point).

// Control + preemption baseline
export { ControlToken } from './control-token.js';
export type { ControlParty, ControlSnapshot, DriveCheck, ControlTokenOptions } from './control-token.js';

// SSRF/nav policy + epoch
export { policyForHolder } from './nav-policy.js';
export type { NavGrant } from './nav-policy.js';
export { NavEpoch } from './nav-epoch.js';

// Per-hop navigation guard (SSRF-via-redirect fence) + initial-URL gate
export { NavInterceptor, navigateSession } from './nav.js';
export type { NavCdp, NavPolicy, NavigableBrowser, NavigateSessionOptions } from './nav.js';

// Deterministic risk classifier
export { classifyRisk, DEFAULT_RISK_PATTERNS } from './risk.js';
export type { RiskTier, TierPatterns, RiskPatterns, RiskSignals } from './risk.js';

// Approvals + audit
export { SessionApprovals } from './approvals.js';
export type { ApprovalDecision, ApprovalRequest, ApprovalDeps } from './approvals.js';
export { SessionAuditLog } from './audit.js';
export type { AuditOutcome, AuditRecordInput, AuditEntry, AuditDb, AuditDeps } from './audit.js';

// Human-event drain
export { StudioEventQueue } from './event-queue.js';
export type { StudioEvent, DrainedEvents } from './event-queue.js';

// Input channel seam (the app's debuggerInputSink implements InputSink; SessionController wraps it)
export { SessionController } from './session-control.js';
export type { InputSink } from './session-control.js';
export type { MouseButton, MouseInput, KeyInput, AgentMouseInput, AgentInputEvent } from './input.js';

// Handle file (~/.wigolo/studio/current.json)
export {
  writeHandle,
  readHandle,
  removeHandle,
  setMyInstanceId,
  getMyInstanceId,
  studioHandlePath,
} from './handle.js';
export type { SessionHandle } from './handle.js';
