/**
 * `@wigolo/studio-mcp-contract` — the `studio_*` MCP wire contract.
 *
 * Two halves, and they are deliberately the only two:
 *  - the SURFACE (`tool-names`, `schemas`): what an endpoint must advertise and what arguments it takes.
 *  - the BEHAVIOUR (`wire`, `harness` + `tests/conformance.spec.ts`): what the answers must contain, and
 *    the seam an implementation plugs into to be checked over its real endpoint.
 *
 * Nothing in `src/` imports core. The single core import in the package is the drift check
 * (`tests/schema-drift.test.ts`), which is where importing core is the point.
 */
export { STUDIO_TOOL_NAMES, STUDIO_UNADVERTISED_CAPABILITY, CORE_TOOL_NAMES_ABSENT_FROM_STUDIO } from './tool-names.js';
export type { StudioToolName } from './tool-names.js';

export { STUDIO_TOOL_SCHEMAS } from './schemas.js';
export type { StudioToolSchema } from './schemas.js';

export {
  toolResultBody,
  loopbackEndpointErrors,
  refusalContractErrors,
  untrustedFenceErrors,
  advertisedToolErrors,
} from './wire.js';
export type { StudioToolResultEnvelope, AdvertisedTool } from './wire.js';

export type { StudioUnderTest } from './harness.js';
