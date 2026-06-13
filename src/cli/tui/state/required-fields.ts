/**
 * hasRequiredFields — pure predicate for entry routing.
 *
 * Returns true when the persisted config is complete enough to skip the
 * first-run wizard:
 *   - a non-empty `llmProvider`, AND
 *   - for keyed cloud providers, a non-empty `llmApiKey`.
 *
 * The `ollama` provider is KEYLESS (it runs against a local LLM server), so it
 * is complete with NO api key — requiring one would re-route a near-zero-
 * friction ollama user back into the wizard. Cloud providers still require a
 * key; absence of either field sends the user into setup.
 *
 * TODO: derive from schema once FieldDef carries a `required` flag —
 * then this can auto-collect all required fields from CATALOG instead of
 * hardcoding the paths above.
 */
import type { PersistedConfig } from '../../../persisted-config.js';

export function hasRequiredFields(config: PersistedConfig): boolean {
  const { settings } = config;
  const provider = settings.llmProvider;
  if (typeof provider !== 'string' || provider.length === 0) return false;
  // Keyless local LLM server — no api key needed to count as configured.
  if (provider === 'ollama') return true;
  const key = settings.llmApiKey;
  return typeof key === 'string' && key.length > 0;
}
