/**
 * Transport policy primitives shared by the account client and its CLI notice.
 *
 * This module owns the definition so the warning and the enforcement cannot
 * drift into two different ideas of which requests leave the machine in
 * cleartext.
 */
import { PRODUCTION_ACCOUNTS_URL } from './constants.js';

/** The env var `config.ts` resolves `accountsUrl` from, before settings. */
export const ACCOUNTS_URL_ENV = 'WIGOLO_ACCOUNTS_URL';

/** Explicit, environment-only escape hatch for deliberate LAN development. */
export const ACCOUNTS_ALLOW_HTTP_ENV = 'WIGOLO_ACCOUNTS_ALLOW_HTTP';

/** Where the effective address came from. `settings` means it is on disk. */
export type AccountsUrlSource = 'env' | 'settings';

export interface AccountsUrlOverride {
  /** The effective address, verbatim — a user must be able to recognise it. */
  readonly url: string;
  readonly source: AccountsUrlSource;
  /** Plain http to a host that is not this machine: credentials in cleartext. */
  readonly insecure: boolean;
  /** The single line `whoami` and `doctor` print. */
  readonly notice: string;
}

/**
 * Loopback, for the purpose of "did anything leave this machine".
 *
 * Deliberately narrow: the whole 127/8 block, the two spellings of the IPv6
 * loopback, and `localhost` (plus the `*.localhost` names RFC 6761 reserves for
 * it). Anything else — a LAN address, a `.local` name, a tunnel host — is off
 * the machine.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * True when reaching this address puts credentials on the wire in the clear.
 *
 * An address that will not parse returns false: the caller's transport will
 * produce its own typed failure, without making an unproven cleartext claim.
 */
export function isCleartextToRemoteHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname);
}

const SOURCE_PHRASE: Record<AccountsUrlSource, string> = {
  env: `set by the ${ACCOUNTS_URL_ENV} environment variable`,
  settings: 'saved in this machine\'s wigolo settings, so it persists across restarts',
};

function describeAccountsUrl(url: string, env: NodeJS.ProcessEnv): AccountsUrlOverride {
  const source: AccountsUrlSource = env[ACCOUNTS_URL_ENV] !== undefined ? 'env' : 'settings';
  const insecure = isCleartextToRemoteHost(url);
  const head = `Notice: account service address is not the default: ${url} (${SOURCE_PHRASE[source]}).`;
  const tail = insecure
    ? ' Warning: this address is unencrypted, so your email address, sign-in code and stored'
      + ' sign-in credential travel to it in cleartext.'
    : ' Your email address, sign-in code and stored sign-in credential go to that address.';
  return { url, source, insecure, notice: `${head}${tail}` };
}

/** The override in force, or `null` when the address is the shipped default. */
export function accountsUrlOverride(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountsUrlOverride | null {
  return url === PRODUCTION_ACCOUNTS_URL ? null : describeAccountsUrl(url, env);
}

/** The line `whoami` and `doctor` print, or `null` for the shipped default. */
export function accountsUrlNotice(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return accountsUrlOverride(url, env)?.notice ?? null;
}

/**
 * The refusal text for a credential-bearing request, or `null` when allowed.
 * The exact opt-out is deliberately env-only and deliberately not truthy.
 */
export function accountsTransportRefusal(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isCleartextToRemoteHost(url) || env[ACCOUNTS_ALLOW_HTTP_ENV] === '1') return null;
  return describeAccountsUrl(url, env).notice;
}
