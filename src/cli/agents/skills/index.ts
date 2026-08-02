/**
 * Agent-skills install engine — public API.
 *
 * planSkills + listSkills NEVER write. applySkillsPlan / removeSkills /
 * removeAllSkills execute. The CLI slice wires these to `wigolo skills`.
 */
export { planSkills } from './planner.js';
export {
  applySkillsPlan,
  listSkills,
  removeSkills,
  planRemove,
  removeAllSkills,
  installSkills,
} from './executor.js';

export type {
  Scope,
  Target,
  TargetKind,
  Pack,
  PlanAction,
  PlanOptions,
  PlanStatus,
  SkillsPlan,
  ApplyResult,
  ListEntry,
  ListState,
  FileResolution,
} from './types.js';
export type { RemoveOptions, RemoveAllOptions } from './executor.js';
export { SUPPORTED_AGENTS, WINDSURF_DIGEST_PACK, resolveTarget } from './targets.js';
export { listPackNames, loadCatalog, loadPack } from './catalog.js';
