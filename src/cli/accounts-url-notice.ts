/**
 * Visibility for the account-service address override (#322, PX1 exit-14).
 *
 * WHY THIS MIRRORS THE PINNED-KEY NOTICE. `src/account/pinned-keys.ts` records
 * the reasoning for the trust-root half of this decision: `WIGOLO_ACCOUNTS_PUBKEY`
 * is env-ONLY so it "cannot be left switched on by a `config --set` a user
 * forgets about", and it is still SHOWN by `whoami`/`doctor` because a support
 * conversation must never be conducted against a build whose trust root has
 * silently moved. The ADDRESS half has neither protection: `accountsUrl` is a
 * catalog field, so it persists to `config.json` and survives every shell, and
 * until this module nothing printed it. The credential consequence is larger
 * than the pubkey's, not smaller — the pinned keys stop a forged entitlement,
 * they do not stop an email, a sign-in code and a rotating 90-day refresh
 * credential being posted to whatever host the address names.
 *
 * WHY IT NOTIFIES AND NEVER REFUSES. Local/LAN RC testing against a
 * locally-run accounts service is the pinned PX1 mode, so a scheme or host
 * refusal here would break the thing the override exists for. The escalation
 * for plain http to a remote host is therefore a louder sentence, not a block.
 *
 * WHY THE SOURCE IS DERIVED FROM (url, env) AND NOT READ BACK OFF DISK. It is
 * the same precedence `envStr` applies in `src/config.ts` — a DEFINED env var
 * wins, otherwise the persisted value does — expressed once, as a pure
 * function, so a surface can attribute the address without opening config.json
 * a second time and without the two answers being able to disagree.
 */
import { PRODUCTION_ACCOUNTS_URL } from '../account/constants.js';

/** The env var `config.ts` resolves `accountsUrl` from, before settings. */
export const ACCOUNTS_URL_ENV = 'WIGOLO_ACCOUNTS_URL';

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
 * the machine, and an unencrypted hop to it is exactly the case being warned
 * about, so guessing generously here would silence the warning that matters.
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
 * An address that will not parse returns FALSE rather than true: the effective
 * value can be a defined-but-empty env var, and claiming "your credentials
 * travel in cleartext" about a string we cannot read would be an assertion the
 * function has not established. The override notice still fires — an
 * unreadable address is very much worth saying out loud — it just does not
 * carry a claim about the transport.
 */
function isCleartextToRemoteHost(url: string): boolean {
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
  // Names the persistence, because that is the actionable half: this one
  // outlives the shell and the reboot that a user assumes cleared it.
  settings: 'saved in this machine\'s wigolo settings, so it persists across restarts',
};

/**
 * The override in force, or `null` when the address is the shipped default.
 *
 * `url` is the ALREADY-RESOLVED effective address (`getConfig().accountsUrl`),
 * passed in rather than read here so the caller cannot end up describing a
 * different address from the one its client is about to POST to.
 */
export function accountsUrlOverride(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountsUrlOverride | null {
  if (url === PRODUCTION_ACCOUNTS_URL) return null;

  // `envStr` takes the env value whenever it is `!== undefined`, empty
  // included, so provenance has to use the same test or the notice would send
  // a user to edit config.json over a variable their shell exported.
  const source: AccountsUrlSource = env[ACCOUNTS_URL_ENV] !== undefined ? 'env' : 'settings';
  const insecure = isCleartextToRemoteHost(url);

  const head = `Notice: account service address is not the default: ${url} (${SOURCE_PHRASE[source]}).`;
  const tail = insecure
    ? ' Warning: this address is unencrypted, so your email address, sign-in code and stored'
      + ' sign-in credential travel to it in cleartext.'
    : ' Your email address, sign-in code and stored sign-in credential go to that address.';

  return { url, source, insecure, notice: `${head}${tail}` };
}

/**
 * The line to print, or `null`. The probe `whoami` and `doctor` consume, kept
 * separate for the same reason `customVerificationKeyNotice` is: a CLI slice
 * printing one line should not have to reason about provenance or transports.
 */
export function accountsUrlNotice(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return accountsUrlOverride(url, env)?.notice ?? null;
}
