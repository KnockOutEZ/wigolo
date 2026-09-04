/**
 * Transport policy for the companion install: which addresses `studio setup` may open at all.
 *
 * The install is a two-hop chain — read a release manifest, then download and RUN what it names.
 * Over cleartext, both hops belong to whoever sits on the path, and the digest the manifest
 * publishes is no defence at all: an attacker who rewrites the manifest rewrites the digest with
 * it. Verifying the download proves the transfer was not corrupted; it says nothing about who
 * wrote the bytes. So authenticity has to come from the transport, and the refusal has to land
 * BEFORE the socket opens rather than after the answer is in hand.
 *
 * Loopback is the single exception, and it is double-locked — a loopback address AND an explicit
 * environment opt-out — so that the fixtures which exercise the install path stay reachable while
 * nothing on the network can slip through the same hole.
 */
import { isCleartextToRemoteHost } from '../account/accounts-url-policy.js';

/** Explicit, environment-only escape hatch for a loopback fixture host. Never for a remote one. */
export const COMPANION_ALLOW_HTTP_ENV = 'WIGOLO_COMPANION_ALLOW_HTTP';

/**
 * The reason this address may not be opened, or `null` when it may be.
 *
 * Reused rather than re-derived: `isCleartextToRemoteHost` already owns the definition of "this
 * machine" that the account transport enforces, and two spellings of loopback in one codebase is
 * how a hole opens in the one nobody looked at.
 */
export function companionTransportRefusal(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `The companion release address is not a usable web address: ${url || '(empty)'}. Expected an https:// address.`;
  }

  if (parsed.protocol === 'https:') return null;

  if (parsed.protocol !== 'http:') {
    return `The companion release address does not use an encrypted web connection: ${url}. Expected an https:// address.`;
  }

  if (isCleartextToRemoteHost(url)) {
    return (
      `The companion release address is unencrypted: ${url}. The release manifest and the ` +
      'application it names would arrive over a connection anyone on the network can rewrite, so ' +
      'nothing was requested. Expected an https:// address.'
    );
  }

  if (env[COMPANION_ALLOW_HTTP_ENV] === '1') return null;
  return (
    `The companion release address is unencrypted: ${url}. Plain http to this machine is allowed ` +
    `only when ${COMPANION_ALLOW_HTTP_ENV}=1 is set, so nothing was requested.`
  );
}
