/**
 * HTTP-tier DNS-rebinding pin (#207).
 *
 * `guardResolvedHost` closes the static-record bypass by validating every
 * resolved IP before we connect. That still leaves a TOCTOU window: the real
 * `fetch` would resolve DNS again at connect time, so an attacker who controls
 * the authoritative resolver can return a public IP for the check and flip to
 * `169.254.169.254` (or RFC-1918) for the connect, inside the TTL.
 *
 * The airtight close on this tier is to hand undici a per-request Agent whose
 * `connect.lookup` returns ONLY the IPs we just validated. The URL, Host
 * header, and TLS `servername` stay on the original hostname so SNI, cert
 * verification, and vhost routing still work against the name.
 *
 * Empty `addresses` (NXDOMAIN / timeout) means there is nothing to pin to —
 * fall through to ordinary fetch so the natural DNS error surfaces.
 */

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import type { LookupAddress } from 'node:dns';
import type { ResolvedAddress } from '../watch/ssrf.js';

function pinnedLookup(addresses: ResolvedAddress[]) {
  return (
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ): void => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) {
      callback(null, addresses as LookupAddress[]);
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  };
}

export function createPinnedDispatcher(addresses: ResolvedAddress[]): Agent {
  if (addresses.length === 0) {
    throw new Error('createPinnedDispatcher requires at least one validated address');
  }
  return new Agent({
    connect: {
      lookup: pinnedLookup(addresses) as import('node:net').LookupFunction,
    },
  });
}

/** Cancel an unused response body so `Agent.close()` can finish. */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already consumed or closed */
  }
}

/**
 * Fetch `url` with the socket pinned to `addresses` when the set is non-empty.
 * The Agent is closed in the background after the response is returned so the
 * caller can still read the body; `close()` waits for in-flight requests.
 * Throws from `fetch` still await `close()` so a failed hop cannot leak an Agent.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit,
  addresses: ResolvedAddress[] | undefined,
): Promise<Response> {
  if (!addresses || addresses.length === 0) {
    return fetch(url, init);
  }
  const agent = createPinnedDispatcher(addresses);
  try {
    const response = await undiciFetch(url, {
      ...(init as UndiciRequestInit),
      dispatcher: agent,
    });
    void agent.close().catch(() => {});
    return response as unknown as Response;
  } catch (err) {
    await agent.close().catch(() => {});
    throw err;
  }
}
