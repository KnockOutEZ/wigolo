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
 *   storeProviderKey   — SP4: store a provider API key securely
 *   readProviderKey    — SP4: read masked provider key + location
 *   deleteProviderKey  — SP4: delete a stored provider key
 *   listConfiguredProviders — SP4: list providers with stored keys
 *   maskValue          — SP4: mask a key value for display
 *   PICKER_PROVIDERS   — SP4: ordered provider list for TUI picker
 *   verifyEndToEnd     — SP6: end-to-end capability smoke + MCP-wiring check
 *
 * Exported types and metadata:
 *   COMPONENT_REGISTRY — ordered list of components with name/purpose/cost
 *   FIREFOX_COMPONENT  — optional Firefox entry
 *   CURATED_ENV_VARS   — ordered list of env/flag vars with group/label/description
 *   ENV_GROUP_LABELS   — display labels for each group
 *   buildDefaultToggles — build initial ToggleMap from COMPONENT_REGISTRY defaults
 *
 * Wave C integration notes:
 *   SP5 (dashboard): add computeStorage/cleanup/exportConfig/importConfig here
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

// SP4: provider key management
export {
  storeProviderKey,
  readProviderKey,
  deleteProviderKey,
  listConfiguredProviders,
  saveProviderSelection,
  maskValue,
  PICKER_PROVIDERS,
} from './provider-keys.js';
export type {
  StoreKeyResult,
  ReadKeyResult as ProviderKeyReadResult,
  DeleteKeyResult,
  ProviderListEntry,
  ProviderKeyOpts,
  PickableProvider,
  SaveProviderResult,
} from './provider-keys.js';

// SP6: end-to-end verification
export { verifyEndToEnd, buildDefaultDeps, formatVerifyResultPlain, checkMcpWiringForAgent } from './verify-e2e.js';
export type {
  CapabilityName,
  CapabilityStatus,
  CapabilityResult,
  McpWiringResult,
  VerifyEndToEndResult,
  VerifyEndToEndDeps,
  McpWiringCheckInput,
} from './verify-e2e.js';
