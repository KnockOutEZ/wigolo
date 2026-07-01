/**
 * Key-store: implements the keychain → encrypted-file → env fallback chain
 * for LLM provider API keys.
 *
 * Resolution order (highest to lowest):
 *   1. OS keychain (via @napi-rs/keyring) — preferred when available.
 *   2. Encrypted file (~/.wigolo/keys/<provider>.enc) — AES-256-GCM.
 *   3. Environment variable (e.g. ANTHROPIC_API_KEY) — read-only, never written here.
 *
 * IMPORTANT: resolveProviderKey NEVER writes to process.env. Secrets are
 * threaded explicitly to avoid leaking into child-process environments or logs.
 *
 * The machine-id used as KEK input is the data-dir path. This is a stable
 * machine-local value that changes when the user relocates their data dir,
 * which is acceptable — they would need to re-enter their key. The threat
 * model (documented in key-crypto.ts) is protection against casual disk reads
 * by unprivileged users, not against root attackers who can read both the
 * data-dir path and the encrypted file.
 */

import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { keychainAvailable, keychainSet, keychainGet, keychainDelete, WIGOLO_SERVICE } from './keychain.js';
import { encryptToFile, decryptFromFile } from './key-crypto.js';
import { providerKeyFromEnv } from '../integrations/cloud/llm/select.js';
import type { LLMProvider } from '../integrations/cloud/llm/types.js';

export interface KeyStoreOpts {
  dataDir: string;
}

export interface ReadKeyResult {
  value: string;
  location: 'keychain' | 'file' | 'env';
}

export interface ProviderEntry {
  provider: LLMProvider | 'custom';
  location: 'keychain' | 'file' | 'env';
}

// Picker-visible providers (groq hidden from picker but still env-supported)
export const PICKER_PROVIDERS: ReadonlyArray<LLMProvider | 'custom'> = [
  'anthropic',
  'openai',
  'gemini',
  'custom',
];

// All providers that can have keystore entries (including groq via env only)
const STORE_PROVIDERS: ReadonlyArray<LLMProvider> = ['anthropic', 'openai', 'gemini', 'groq'];

/**
 * Process-lifetime memo for resolveProviderKey, keyed by `provider:dataDir`.
 *
 * Without this, every format=answer search resolves the key twice (the
 * isLlmConfigured check + the actual runLlmText call), and on the encrypted-
 * file tier each resolution runs scrypt (~40-80ms). The memo collapses that
 * to a single decrypt per process and is invalidated whenever a key is
 * stored or deleted, so a re-keying in the TUI takes effect immediately.
 *
 * Values: a resolved string, or `null` for a verified miss (so repeated
 * misses don't re-probe keychain/file/env every call). `undefined` (absent
 * key) is stored as `null`.
 */
const _resolveMemo = new Map<string, string | null>();

function memoKey(provider: LLMProvider, dataDir: string): string {
  return `${provider}:${dataDir}`;
}

/** Drop every memo entry for a provider across all data dirs. */
function invalidateMemo(provider: LLMProvider): void {
  const prefix = `${provider}:`;
  for (const k of _resolveMemo.keys()) {
    if (k.startsWith(prefix)) _resolveMemo.delete(k);
  }
}

/** Test/maintenance hook: clear the entire resolve memo. */
export function clearKeyStoreMemo(): void {
  _resolveMemo.clear();
}

/** Returns the keychain service name for a given provider. */
function keychainKey(provider: LLMProvider): string {
  return `${WIGOLO_SERVICE}-${provider}`;
}

/** Returns the encrypted file path for a given provider. */
function encFilePath(provider: LLMProvider, dataDir: string): string {
  return join(dataDir, 'keys', `${provider}.enc`);
}

/**
 * Store a provider API key securely.
 * Prefers keychain; falls back to encrypted file when keychain unavailable.
 * Never writes to process.env.
 */
export async function storeKey(
  provider: LLMProvider,
  value: string,
  opts: KeyStoreOpts,
): Promise<{ location: 'keychain' | 'file' }> {
  // Invalidate before the write so a concurrent reader can't cache a stale miss
  // between the write completing and this line running.
  invalidateMemo(provider);
  if (keychainAvailable()) {
    try {
      keychainSet(keychainKey(provider), provider, value);
      invalidateMemo(provider);
      return { location: 'keychain' };
    } catch {
      // Keychain call failed despite availability probe — fall through to file.
    }
  }
  await encryptToFile(value, opts.dataDir, encFilePath(provider, opts.dataDir));
  invalidateMemo(provider);
  return { location: 'file' };
}

/**
 * Read a stored key. Returns the raw value and where it was found.
 * Returns null when neither keychain nor file has a key.
 * Does NOT fall through to env — resolveProviderKey does that.
 */
export async function readKey(
  provider: LLMProvider,
  opts: KeyStoreOpts,
): Promise<ReadKeyResult | null> {
  // 1. Keychain
  if (keychainAvailable()) {
    const kc = keychainGet(keychainKey(provider), provider);
    if (kc !== null) return { value: kc, location: 'keychain' };
  }

  // 2. Encrypted file
  const filePath = encFilePath(provider, opts.dataDir);
  if (existsSync(filePath)) {
    try {
      const value = await decryptFromFile(opts.dataDir, filePath);
      return { value, location: 'file' };
    } catch {
      // Corrupt/tampered file — treat as miss (do not silently expose garbage)
    }
  }

  return null;
}

/**
 * Delete a stored key from whichever tier holds it.
 */
export async function deleteKey(
  provider: LLMProvider,
  opts: KeyStoreOpts,
): Promise<void> {
  // Remove from keychain if present
  if (keychainAvailable()) {
    keychainDelete(keychainKey(provider), provider);
  }
  // Remove encrypted file if present
  const filePath = encFilePath(provider, opts.dataDir);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
  invalidateMemo(provider);
}

/**
 * Full resolution chain: keychain → file → env.
 * Returns the raw key value or undefined if none configured.
 * NEVER mutates process.env.
 *
 * Memoization: only the EXPENSIVE keychain/file tier is memoized (a `string`
 * hit, or `null` for a verified keychain+file miss). The env tier is read
 * live on every call and never cached, so an env-var change is always picked
 * up and the value never goes stale. The memo collapses the repeated scrypt
 * decrypt / keychain probe that the synthesis hot path triggers (the
 * isLlmConfigured check + the runLlmText call), and is invalidated by
 * storeKey/deleteKey so a TUI re-keying takes effect immediately.
 */
export async function resolveProviderKey(
  provider: LLMProvider,
  opts: KeyStoreOpts,
): Promise<string | undefined> {
  const cacheKey = memoKey(provider, opts.dataDir);

  let storedValue: string | null;
  if (_resolveMemo.has(cacheKey)) {
    // Memo hit: keychain/file result is cached (value or verified miss).
    storedValue = _resolveMemo.get(cacheKey) ?? null;
  } else {
    // 1 + 2: keychain and file (the expensive tiers).
    const stored = await readKey(provider, opts);
    storedValue = stored ? stored.value : null;
    _resolveMemo.set(cacheKey, storedValue);
  }
  if (storedValue !== null) return storedValue;

  // 3: provider-specific env var (read-only, ALWAYS live — never memoized so
  // env changes and per-test env teardown are respected). Accepts the canonical
  // var or an alias (e.g. GEMINI_API_KEY as well as GOOGLE_API_KEY).
  const envValue = providerKeyFromEnv(provider, process.env);
  if (envValue) return envValue;

  // 4: WIGOLO_LLM_API_KEY last-resort fallback (issue #102). The TUI writes
  // this generic var; honor it ONLY when WIGOLO_LLM_PROVIDER explicitly names
  // THIS provider. During auto-detect (no explicit provider) the var is
  // ambiguous, so it is never used here — selectProvider's auto-detect loop
  // calls this with each provider in turn, none of which will match.
  if (process.env.WIGOLO_LLM_PROVIDER === provider) {
    const generic = process.env.WIGOLO_LLM_API_KEY;
    if (generic) return generic;
  }

  return undefined;
}

/**
 * List all providers that have a stored key (keychain or file; env not included).
 */
export async function listProviders(opts: KeyStoreOpts): Promise<ProviderEntry[]> {
  const results: ProviderEntry[] = [];
  for (const provider of STORE_PROVIDERS) {
    const found = await readKey(provider, opts);
    if (found !== null) {
      results.push({ provider, location: found.location });
    }
  }
  return results;
}
