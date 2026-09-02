/**
 * Public surface of `src/security/` for the companion split (`wigolo/security`).
 *
 * Not a general barrel: it carries exactly what the extracted studio domain layer was
 * measured importing. Core's own modules keep importing these files directly.
 */
export { neutralizeMarkers, UNTRUSTED_STUDIO_NOTICE } from './untrusted.js';
export { guardNavigation } from './ssrf.js';
export type { NavSource } from './ssrf.js';
export { keychainAvailable, keychainGet, keychainSet } from './keychain.js';
export { decryptFromFile, encryptToFile } from './key-crypto.js';
