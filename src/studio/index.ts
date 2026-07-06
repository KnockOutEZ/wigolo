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
export type { MouseButton, MouseInput, KeyInput, AgentMouseInput, AgentInputEvent } from './input-events.js';

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

// Perception — a11y snapshot + live ref resolution (host binds these to the CDP transport)
export { PageSnapshotter, buildSnapshot, flattenDom } from './perception/snapshot.js';
export type { PageSnapshot, SnapshotElement, PerceptionCdp, AxNode, DomNode, DomInfo } from './perception/snapshot.js';
export { createResolver, isResolveError } from './perception/resolve.js';
export type { ResolveDeps, ResolveResult, ResolvedTarget, ResolveErrorReason } from './perception/resolve.js';
export { computeFingerprint } from './perception/id.js';

// Marking domain (P2) — structured target + self-heal + generalize + in-memory store + node-path bridge.
// Pure/perception-only (no better-sqlite3) so the barrel stays loadable in the Electron main.
export { buildTarget, buildTargetFromFlat, indexAxByBackendNode } from './mark/target.js';
export type { StructuredTarget } from './mark/target.js';
export { heal } from './mark/heal.js';
export type { HealResult, HealCandidate, HealConfidence } from './mark/heal.js';
export { generalize, applyGeometry, segEditDistance } from './mark/generalize.js';
export type { GeneralizeResult, GeneralizeMatch, GeneralizeStructural, GenBox, GeneralizeConfidence } from './mark/generalize.js';
export { MarkStore } from './mark/store.js';
export type { StudioMark } from './mark/store.js';
export { resolveNodePath } from './mark/pick.js';

// Observe orchestration (fenced untrusted snapshot + event drain)
export { createObserver } from './observe.js';
export type { ObserverDeps } from './observe.js';

// Act orchestration (gated navigate/click/type/scroll; risk gate + park)
export { createActHandler, keystrokeEvents } from './act.js';
export type { ActHandlerDeps, ActControlToken, AgentInputChannel, ParkedAction, AuthSource } from './act.js';

// Pre-grant scope store (human-authorized risky-action classes)
export { PreGrantStore, deriveDomain } from './pre-grant.js';
export type { PreGrantEntry } from './pre-grant.js';

// Credential arc primitives (agent never types/perceives credentials)
export { isCredentialContext, isCredentialField, refuseAgentType, CREDENTIAL_URL } from './credential.js';
export type { FieldSemantics } from './credential.js';

// Session-drive seam (D19 — session-targeted fetch/extract/crawl)
export { createSessionDrive } from './session-drive.js';
export type {
  SessionDrive,
  SessionDriveDeps,
  StudioSessionsAccessor,
  DriveControlToken,
  GatedNavResult,
} from './session-drive.js';

// Capture pipeline: NOT re-exported here — capture/artifacts → cache/db → better-sqlite3, which cannot
// load in the Electron main (spec §13.7). studio_capture is P3 and reaches the cache via a decoupled
// path decided then. The barrel is deliberately kept better-sqlite3-free so `wigolo/studio` loads in
// the Electron main. CaptureResult flows through SessionDriveDeps as a type-only reference (erased).

// ── Cross-package surface the Electron host + gateway need through the one `wigolo/studio` subpath ──

// Untrusted-data boundary (page text is data, never instructions) — lives in security/, re-exported here.
export { UNTRUSTED_STUDIO_NOTICE, neutralizeMarkers, wrapUntrusted } from '../security/untrusted.js';

// The MCP dispatch contract the host implements + the studio tool I/O types.
export { isStudioToolError } from '../daemon/studio-dispatch.js';
export type {
  StudioHostHandlers,
  StudioObserveInput,
  StudioObserveOutput,
  StudioActInput,
  StudioActOutput,
  StudioMarksInput,
  StudioMarksOutput,
  StudioGeneralizeOutput,
  StudioCaptureInput,
  StudioCaptureOutput,
  StudioSpawnInput,
  StudioSpawnOutput,
  StudioCloseInput,
  StudioCloseOutput,
  StudioListOutput,
  StudioSessionView,
  StudioToolError,
} from '../daemon/studio-dispatch.js';

// The embedded loopback MCP gateway (the app boots this in-process as the agent endpoint).
export { DaemonHttpServer } from '../daemon/http-server.js';
export type { DaemonOptions, DaemonAuthConfig, UpgradeHandler } from '../daemon/http-server.js';

// The bearer-authed MCP client for the gateway (the same client the stdio proxy uses; the e2e drives with it).
export { DaemonProxy } from '../daemon/proxy.js';

// Studio-only MCP server (hosts just studio_* — better-sqlite3-free, boots in the Electron main). The
// gateway passes `mcpServerFactory: () => createStudioMcpServer(...)` to the embedded DaemonHttpServer.
export { createStudioMcpServer } from '../daemon/studio-mcp-server.js';
export type { StudioMcpServerDeps } from '../daemon/studio-mcp-server.js';

// Per-launch bearer + Origin/Host guard for the gateway.
export { mintHostToken, resolveHostToken, checkOriginHost, checkAuth, checkAuthSubprotocol } from './auth.js';
export type { HostTokenResolution } from './auth.js';
