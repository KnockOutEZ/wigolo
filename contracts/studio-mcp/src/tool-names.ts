/**
 * The `studio_*` MCP surface, named.
 *
 * This package is the CONTRACT, not a view of the implementation. It states the wire surface
 * independently of `src/`, so a Studio implementation can be checked against it from outside — and so
 * a future repo split is a `git mv` rather than a refactor. Nothing here imports core.
 */

/**
 * The ten tools a Studio MCP endpoint MUST advertise, and the only ten it may advertise. Sorted, so
 * an equality assertion against a sorted `listTools()` result reads as a set comparison.
 *
 * `studio_open` and `studio_spawn` are BOTH here and both required. They route to one host handler
 * (PIN-SPLIT(a)) but they are two distinct wire names, and an implementation that advertises only one
 * of them breaks agents written against the other.
 */
export const STUDIO_TOOL_NAMES = [
  'studio_act',
  'studio_capture',
  'studio_close',
  'studio_extract_set',
  'studio_list',
  'studio_marks',
  'studio_observe',
  'studio_open',
  'studio_say',
  'studio_spawn',
] as const;

export type StudioToolName = (typeof STUDIO_TOOL_NAMES)[number];

/**
 * A capability that is callable on the authed transport but is DELIBERATELY NOT ADVERTISED — it is
 * not a tool, it is the core fetch pipeline's escalation rung reaching the live browser session, and
 * it is registered at the gateway seam only.
 *
 * Both halves of that are contract properties, and both are asserted:
 *  - it MUST answer on the transport (otherwise the escalation rung silently 404s), and
 *  - it MUST NOT appear in `listTools()` (otherwise an agent starts calling it, and the one-seam
 *    capability becomes a tool with every seam a tool carries).
 */
export const STUDIO_UNADVERTISED_CAPABILITY = 'studio_fetch';

/**
 * The tool names an agent must NEVER see on a Studio endpoint. The Studio surface is separate from
 * the core surface by design (D13): the endpoint hosts `studio_*` only, and it boots without core's
 * subsystems, so a core name appearing here means either the wrong server object was mounted or the
 * split has been undone.
 */
export const CORE_TOOL_NAMES_ABSENT_FROM_STUDIO = [
  'agent',
  'cache',
  'crawl',
  'diff',
  'extract',
  'fetch',
  'find_similar',
  'research',
  'search',
  'watch',
] as const;
