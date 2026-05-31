/**
 * hasRequiredFields — pure predicate for entry routing.
 *
 * Returns true only when the persisted config has both:
 *   - llmProvider: a non-empty string
 *   - llmApiKey: a non-empty string
 *
 * Either absence sends the user into the first-run wizard so they can
 * complete the LLM step before reaching the settings shell.
 *
 * TODO: derive from schema once FieldDef carries a `required` flag —
 * then this can auto-collect all required fields from CATALOG instead of
 * hardcoding the two paths above.
 */
import type { PersistedConfig } from '../../../persisted-config.js';

export function hasRequiredFields(config: PersistedConfig): boolean {
  const { settings } = config;
  const provider = settings.llmProvider;
  const key = settings.llmApiKey;
  return (
    typeof provider === 'string' && provider.length > 0 &&
    typeof key === 'string' && key.length > 0
  );
}
