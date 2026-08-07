import type { PersistedConfig } from '../../../persisted-config.js';
import { CATALOG } from '../schema/catalog.js';
import type { CategoryDef, Ctx, FieldDef } from '../schema/types.js';

function isActiveRequiredField(field: FieldDef, ctx: Ctx): boolean {
  if (field.visible && !field.visible(ctx)) return false;
  return typeof field.required === 'function' ? field.required(ctx) : field.required === true;
}

function hasCompleteValue(field: FieldDef, value: unknown): boolean {
  if (value === undefined || value === null) return false;

  if (field.kind === 'multiselect') {
    return Array.isArray(value) && value.length > 0;
  }
  if (field.kind === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (field.kind === 'toggle') {
    return typeof value === 'boolean';
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return false;
}

function hasSecretReference(config: PersistedConfig, field: FieldDef): boolean {
  if (field.secret !== true) return false;
  return hasCompleteValue(field, config.settings[`${field.settingsPath}KeyLocation`]);
}

/** Return whether persisted settings satisfy every active schema requirement. */
export function hasRequiredFields(
  config: PersistedConfig,
  catalog: ReadonlyArray<CategoryDef> = CATALOG,
): boolean {
  const ctx: Ctx = { current: config.settings, pending: {} };
  const requiredFields = catalog.flatMap((category) => category.fields)
    .filter((field) => isActiveRequiredField(field, ctx));
  return requiredFields.every((field) => {
    if (hasCompleteValue(field, config.settings[field.settingsPath])) return true;
    if (hasSecretReference(config, field)) return true;

    // The legacy provider block predates per-field secret-location pointers.
    // Scope it to the LLM key and require the selected provider to match.
    return field.secret === true
      && field.settingsPath === 'llmApiKey'
      && config.provider?.name === config.settings.llmProvider
      && typeof config.provider?.keyLocation === 'string'
      && config.provider.keyLocation.length > 0;
  });
}
