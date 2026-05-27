/**
 * SP4 provider key actions — thin wrappers around the security/key-store module.
 *
 * All side-effecting logic lives here so the TUI components and headless CLI
 * can share the same implementation. Components render results; actions compute
 * them. No Ink/React dependency in this file.
 *
 * Keys are NEVER returned in full — readProviderKey returns a masked form.
 * The full value is only accessible via the key-store module directly (for
 * synthesis calls).
 */

import { storeKey, readKey, deleteKey, listProviders, PICKER_PROVIDERS } from '../../../security/key-store.js';
import { writePersistedConfig, defaultConfigPath } from '../../../persisted-config.js';
import type { LLMProvider } from '../../../integrations/cloud/llm/types.js';

export interface ProviderKeyOpts {
  dataDir: string;
}

export type PickableProvider = LLMProvider | 'custom';

export interface SaveProviderResult {
  ok: boolean;
  /** Where the secret landed; null for custom URL (persisted to config only). */
  location: 'keychain' | 'file' | null;
  error?: string;
}

export interface StoreKeyResult {
  ok: boolean;
  location?: 'keychain' | 'file';
  error?: string;
}

export interface ReadKeyResult {
  /** Masked form of the stored value (e.g. "sk-ant-api0••••••••") */
  masked: string;
  location: 'keychain' | 'file' | 'env';
}

export interface DeleteKeyResult {
  ok: boolean;
  error?: string;
}

export interface ProviderListEntry {
  provider: LLMProvider | 'custom';
  location: 'keychain' | 'file' | 'env';
}

/** Providers shown in the picker UI. groq is hidden (env-only) per spec. */
export { PICKER_PROVIDERS };

/**
 * Store an API key securely for the given provider.
 * Returns the storage location so the TUI can confirm to the user where it went.
 */
export async function storeProviderKey(
  provider: LLMProvider,
  value: string,
  opts: ProviderKeyOpts,
): Promise<StoreKeyResult> {
  try {
    const result = await storeKey(provider, value, opts);
    return { ok: true, location: result.location };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a stored key and return its masked form + storage location.
 * Returns null when no key is configured for the provider.
 * NEVER returns the full key value — masking is applied here, not in caller.
 */
export async function readProviderKey(
  provider: LLMProvider,
  opts: ProviderKeyOpts,
): Promise<ReadKeyResult | null> {
  const result = await readKey(provider, opts);
  if (result === null) return null;
  return {
    masked: maskValue(result.value),
    location: result.location,
  };
}

/**
 * Delete the stored key for a provider from whichever tier holds it.
 */
export async function deleteProviderKey(
  provider: LLMProvider,
  opts: ProviderKeyOpts,
): Promise<DeleteKeyResult> {
  try {
    await deleteKey(provider, opts);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List all providers that have a stored key (keychain or file).
 * Returns provider names + storage locations. Never returns key values.
 */
export async function listConfiguredProviders(
  opts: ProviderKeyOpts,
): Promise<ProviderListEntry[]> {
  const list = await listProviders(opts);
  // ProviderEntry only contains provider + location — no secret values
  return list;
}

/**
 * Save a provider selection end-to-end: store the secret in the keystore (or,
 * for custom URLs, persist the URL to config) AND persist the provider block
 * (name + keyLocation) to config.json.
 *
 * config.json NEVER receives the raw key — only the provider name + the
 * location reference. This is the single side-effecting save path so the
 * TUI component stays thin and the no-secret-persistence guarantee is unit-
 * testable here without an Ink render.
 *
 * For provider === 'custom', the `value` is an OpenAI-compatible endpoint URL,
 * not a secret; it is stored in config settings (WIGOLO_LLM_PROVIDER) and the
 * provider block records keyLocation 'env' (custom backend reads the URL at
 * runtime, no API key tier).
 *
 * @param configPath override for tests; defaults to defaultConfigPath()
 */
export async function saveProviderSelection(
  provider: PickableProvider,
  value: string,
  opts: ProviderKeyOpts,
  configPath: string = defaultConfigPath(),
): Promise<SaveProviderResult> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, location: null, error: 'value cannot be empty' };
  }

  if (provider === 'custom') {
    try {
      writePersistedConfig(configPath, {
        provider: { name: 'custom', keyLocation: 'env' },
        settings: { WIGOLO_LLM_PROVIDER: trimmed },
      });
      return { ok: true, location: null };
    } catch (err) {
      return { ok: false, location: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Cloud provider: store the secret in the keystore, then record only the
  // provider name + location in config.json (never the key).
  const stored = await storeProviderKey(provider, trimmed, opts);
  if (!stored.ok || !stored.location) {
    return { ok: false, location: null, error: stored.error ?? 'failed to store key' };
  }
  try {
    writePersistedConfig(configPath, {
      provider: { name: provider, keyLocation: stored.location },
    });
  } catch (err) {
    return { ok: false, location: stored.location, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, location: stored.location };
}

/**
 * Mask an API key for display. Shows the first 4-8 characters then asterisks.
 * Rule: show at most min(8, ceil(len * 0.25)) characters.
 * A key shorter than 4 chars is fully masked.
 */
export function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  const show = Math.min(8, Math.ceil(value.length * 0.25));
  return value.slice(0, show) + '*'.repeat(Math.max(4, value.length - show));
}
