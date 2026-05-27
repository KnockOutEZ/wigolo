/**
 * Thin wrapper around the optional @napi-rs/keyring native binding.
 *
 * Exports a stable interface regardless of whether the binding loaded.
 * All callers go through keychainAvailable() before calling set/get/delete.
 *
 * Design: we use createRequire so this module stays ESM-first while importing
 * a CJS binding. If the binding fails to load (missing binary, sandbox EPERM,
 * etc.) keychainAvailable() returns false and the file-fallback tier is used.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface KeyringEntry {
  setPassword(secret: string): void;
  getPassword(): string;
  deleteCredential(): void;
}

interface KeyringModule {
  Entry: new (service: string, user: string) => KeyringEntry;
}

let _keyring: KeyringModule | null = null;
let _checked = false;

function loadKeyring(): KeyringModule | null {
  if (_checked) return _keyring;
  _checked = true;
  try {
    _keyring = require('@napi-rs/keyring') as KeyringModule;
    return _keyring;
  } catch {
    _keyring = null;
    return null;
  }
}

/** Returns true if the OS keychain is accessible. */
export function keychainAvailable(): boolean {
  const mod = loadKeyring();
  if (!mod) return false;
  // Try a no-op probe: instantiate Entry without actually calling setPassword.
  // If the binary loaded but the OS keychain is sandboxed, setPassword would
  // throw; we let storeKey handle that per-call, not here.
  try {
    new mod.Entry('wigolo-probe', 'probe');
    return true;
  } catch {
    return false;
  }
}

const WIGOLO_SERVICE = 'wigolo';

/** Store a secret in the OS keychain. Throws on failure. */
export function keychainSet(service: string, user: string, value: string): void {
  const mod = loadKeyring();
  if (!mod) throw new Error('keychain not available');
  const entry = new mod.Entry(service, user);
  entry.setPassword(value);
}

/** Retrieve a secret from the OS keychain. Returns null if not found. */
export function keychainGet(service: string, user: string): string | null {
  const mod = loadKeyring();
  if (!mod) return null;
  try {
    const entry = new mod.Entry(service, user);
    return entry.getPassword();
  } catch {
    return null;
  }
}

/** Delete a secret from the OS keychain. Silently ignores missing entries. */
export function keychainDelete(service: string, user: string): void {
  const mod = loadKeyring();
  if (!mod) return;
  try {
    const entry = new mod.Entry(service, user);
    entry.deleteCredential();
  } catch {
    // Not found is not an error on delete
  }
}

export { WIGOLO_SERVICE };
