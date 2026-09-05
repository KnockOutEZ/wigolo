/**
 * Public surface of `src/companion/` for the companion split (`wigolo/companion`).
 *
 * Not a general barrel: it carries exactly what the extracted studio domain layer and the app
 * were MEASURED importing from this directory (A4 2026-09-02, widened at A6 2026-09-02 from the
 * compiler's own enumeration once B1 rewrote `packages/studio-core` onto these subpaths, and again
 * at A7 2026-09-02 for the two origin-budget defaults the extracted specs name, and again at
 * A8 2026-09-03 for the auth-origin ledger and the escalation counter, whose modules stay here
 * and which `exports` reaches by no other path — there is no wildcard subpath). Every
 * other kept file here is reached by core's own seams — the daemon, the CLI, config, the fetch
 * router — which import the module directly and do not need a subpath at all.
 *
 * The ceiling rule holds: a symbol goes in only with a named import site outside core. Daemon-route
 * auth (`checkAuth`, `checkAuthSubprotocol`, `checkOriginHost`) was deliberately absent through A8 on
 * exactly that rule — spec §2.1 seam 2, core imports it directly, and nothing outside core had been
 * MEASURED reaching for it. That measurement is what changed, not the rule: `StudioHostServer` in the
 * extracted app validates the bearer token, the WebSocket subprotocol and the Origin/Host pair on its
 * own loopback surface, and the deleted `wigolo/studio` barrel was its only door. The trio therefore
 * enters by the ceiling rule rather than in spite of it, and it enters HERE rather than on a subpath of
 * its own because `auth.ts` already reaches this barrel (`mintHostToken`, `resolveHostToken`) and a
 * second door onto one module is a second thing to keep in step.
 */

// `run-store.ts`, `profile-store.ts`, `perception/spill.ts` — on-disk state resolution.
export { studioStateDir } from './paths.js';

// `authenticated-origin.ts` — the credential-class predicate.
export { normalizeOrigin, type AuthenticatedOriginOverrides } from './origin.js';

// `session.ts` mints the host token; the app resolves the configured one (D1 switch table).
export { mintHostToken, resolveHostToken } from './auth.js';

// `studio-host.ts` — spec §2.1 seam 2. The app's own loopback HTTP/WS surface runs the same
// DNS-rebinding defence core's daemon runs, from the same implementation: a re-derived copy on the
// app side would drift from the one the daemon enforces, and the two surfaces answer the same token.
export {
  checkAuth,
  checkAuthSubprotocol,
  checkOriginHost,
  type AuthCheck,
  type AuthRequestLike,
} from './auth.js';

// `agent-drive-gate.ts` — per-origin escalation budget. The two defaults are the library
// constants the gate's own spec asserts against: a test that hardcodes `20` mirrors a number
// with nothing keeping the two in step, and goes green on a stale value the day core changes it.
export {
  budgetOrigin,
  budgetRefusal,
  OriginBudget,
  DEFAULT_ORIGIN_BUDGET,
  DEFAULT_ANONYMOUS_ORIGIN_BUDGET,
  type OriginBudgetVerdict,
  type OriginClass,
} from './origin-budget.js';

// `agent-drive-gate.ts`, `human-solve-bridge.ts` — the counter key union. `studio-host.ts` bumps
// the counters themselves; both modules stay in core and are reachable by no other subpath.
export { bumpEscalationCounter, type EscalationCounterKey } from './escalation-counters.js';

// `studio-host.ts` records and reads the login-handoff ledger; `authenticated-origin.test.ts`
// drives the whole store — the override projection, the human-only patch and its refusal, the
// setting keys it writes under, and the count `doctor` reports.
export {
  recordAuthOrigin,
  readAuthOriginLedger,
  readOriginOverrides,
  overridePatch,
  authenticatedOriginCount,
  AgentWriteRefusedError,
  ANONYMOUS_ORIGINS_KEY,
  AUTHENTICATED_ORIGINS_KEY,
} from './auth-origin-store.js';

// The app's session handle (D1 switch table; C4 deletes the `wigolo/studio` barrel it uses today).
export {
  writeHandle,
  readHandle,
  removeHandle,
  setMyInstanceId,
  getMyInstanceId,
  studioHandlePath,
  type SessionHandle,
} from './handle.js';
