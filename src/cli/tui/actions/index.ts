/**
 * Actions layer — public API for SP3 and Wave C (SP4/SP5/SP6).
 *
 * Every export here is a pure-ish async function with no Ink/React dependency.
 * Components call these functions and render the returned state; all business
 * logic lives here so it can be tested headlessly and reused by the plain CLI.
 *
 * Exported actions:
 *   detectSystem       — system requirements check
 *   writeMcpConfig     — write MCP config entries with per-item results
 *   writeEnvSettings   — persist curated env/flag values to config.json
 *   readEnvSettings    — read curated env/flag values from config.json
 *   installBrowser     — run warmup for browser + ML models
 *
 * Exported types and metadata:
 *   COMPONENT_REGISTRY — ordered list of components with name/purpose/cost
 *   FIREFOX_COMPONENT  — optional Firefox entry
 *   CURATED_ENV_VARS   — ordered list of env/flag vars with group/label/description
 *   ENV_GROUP_LABELS   — display labels for each group
 *   buildDefaultToggles — build initial ToggleMap from COMPONENT_REGISTRY defaults
 *
 * Wave C integration notes:
 *   SP4 (provider/keys): add storeKey/readKey/deleteKey/listProviders here
 *   SP5 (dashboard): add computeStorage/cleanup/exportConfig/importConfig here
 *   SP6 (verification): add verifyEndToEnd here
 */

export { detectSystem } from './detect-system.js';
export type { SystemInfo } from './detect-system.js';

export { writeMcpConfig } from './write-config.js';
export type { WriteMcpConfigOptions, WriteMcpConfigResult } from './write-config.js';

export { writeEnvSettings, readEnvSettings } from './persist-settings.js';

export { installBrowser } from './install-browser.js';
export type { InstallBrowserOptions, InstallBrowserResult } from './install-browser.js';

export {
  COMPONENT_REGISTRY,
  FIREFOX_COMPONENT,
  CURATED_ENV_VARS,
  ENV_GROUP_LABELS,
  buildDefaultToggles,
} from './types.js';
export type {
  ComponentId,
  ComponentMeta,
  ToggleMap,
  WriteResult,
  WriteStatus,
  EnvVarMeta,
  EnvGroupId,
  ScreenId,
  EntryMode,
} from './types.js';
