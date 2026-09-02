/**
 * Public surface of `src/companion/` for the companion split (`wigolo/companion`).
 *
 * Not a general barrel: it carries exactly what the extracted studio domain layer and the app
 * were MEASURED importing from this directory (A4 2026-09-02, widened at A6 2026-09-02 from the
 * compiler's own enumeration once B1 rewrote `packages/studio-core` onto these subpaths). Every
 * other kept file here is reached by core's own seams — the daemon, the CLI, config, the fetch
 * router — which import the module directly and do not need a subpath at all.
 *
 * The ceiling rule holds: a symbol goes in only with a named import site outside core. Daemon-route
 * auth (`checkAuth`, `checkAuthSubprotocol`, `checkOriginHost`) is deliberately absent — it is spec
 * §2.1 seam 2, core imports it directly, and nothing outside core was measured reaching for it.
 */

// `run-store.ts`, `profile-store.ts`, `perception/spill.ts` — on-disk state resolution.
export { studioStateDir } from './paths.js';

// `authenticated-origin.ts` — the credential-class predicate.
export { normalizeOrigin, type AuthenticatedOriginOverrides } from './origin.js';

// `session.ts` mints the host token; the app resolves the configured one (D1 switch table).
export { mintHostToken, resolveHostToken } from './auth.js';

// `agent-drive-gate.ts` — per-origin escalation budget.
export {
  budgetOrigin,
  budgetRefusal,
  OriginBudget,
  type OriginBudgetVerdict,
  type OriginClass,
} from './origin-budget.js';

// `agent-drive-gate.ts`, `human-solve-bridge.ts` — the counter key union.
export { type EscalationCounterKey } from './escalation-counters.js';

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
