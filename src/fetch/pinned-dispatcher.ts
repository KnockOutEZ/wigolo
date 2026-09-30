import { Agent, type buildConnector } from 'undici';
import { lookup as nodeLookup } from 'node:dns';

/**
 * Pin a connection to the addresses SSRF validation already cleared.
 *
 * `guardResolvedHost` resolves a hostname and checks every returned address, but the socket then
 * resolves DNS *again* at connect time. An attacker who controls the authoritative resolver can
 * answer with a public IP for our check and a private one for the connect, inside the TTL window —
 * classic DNS rebinding, and the resolved-IP re-check cannot see it because it has already run.
 *
 * The fix is to stop the second resolution happening at all: hand the socket a `lookup` that
 * returns the exact addresses we validated, so there is no window to race.
 *
 * WHY A LOOKUP HOOK RATHER THAN REWRITING THE URL TO THE IP
 * --------------------------------------------------------
 * Rewriting `https://example.com/x` to `https://93.184.216.34/x` would also avoid re-resolution,
 * and it would break TLS: the certificate is checked against the name in the URL, so the request
 * would either fail verification or have to disable it. A `lookup` hook changes only which address
 * the socket dials. The SNI name, the Host header and certificate verification all still use the
 * real hostname, so pinning costs nothing in transport security.
 */

/** The `dns.lookup` shape `net.connect` accepts. Both callback arities are in play — see below. */
export type PinnedLookup = (
  hostname: string,
  options: { family?: number; all?: boolean; hints?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void;

export interface ValidatedAddress {
  address: string;
  family: number;
}

/**
 * Build the lookup hook. Exported separately from the Agent so it can be unit-tested without
 * opening a socket.
 *
 * Two behaviours worth stating, because both are security-relevant:
 *
 *  - **A different hostname is never pinned.** If the socket asks for a host we did not validate,
 *    we fall through to real DNS rather than handing back this host's addresses. Returning them
 *    would send a request for host B to host A's IP, which is a worse bug than the one being
 *    fixed. In practice the caller builds a fresh hook per validated host, so this is a guard
 *    against future misuse rather than a path we expect to hit.
 *  - **An empty address set is never pinned.** Callers must not construct this with `[]`; if they
 *    do, we fall back to real DNS instead of failing the connection in a way that looks like a
 *    network error.
 */
export function createPinnedLookup(
  hostname: string,
  addresses: ValidatedAddress[],
  realLookup: typeof nodeLookup = nodeLookup,
): PinnedLookup {
  return (host, options, callback) => {
    if (host !== hostname || addresses.length === 0) {
      // Not ours to pin — defer to the real resolver.
      (realLookup as unknown as PinnedLookup)(host, options, callback);
      return;
    }

    // Honour an explicit family request; `family: 0` / undefined means "either".
    const wanted = options?.family;
    const matching =
      wanted === 4 || wanted === 6 ? addresses.filter((a) => a.family === wanted) : addresses;

    if (matching.length === 0) {
      // We hold addresses, but none in the family the socket asked for. Report it as a resolution
      // failure rather than silently widening to a family the caller rejected.
      const err: NodeJS.ErrnoException = new Error(
        `no validated IPv${wanted} address for ${host}`,
      );
      err.code = 'ENOTFOUND';
      callback(err, '');
      return;
    }

    // `all: true` wants the array form; otherwise the (address, family) arity.
    if (options?.all) {
      callback(null, matching.map((a) => ({ address: a.address, family: a.family })));
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}

/**
 * An undici Agent whose sockets dial only the validated addresses.
 *
 * The caller owns the returned Agent and must `close()` (or `destroy()`) it once the response body
 * has been consumed — an Agent holds a connection pool, so one per request that is never closed is
 * a socket leak.
 */
export function createPinnedAgent(hostname: string, addresses: ValidatedAddress[]): Agent {
  // `BuildOptions` is a union whose TCP member carries `lookup`; one cast at the boundary keeps
  // that from leaking into the rest of the module, where the hook stays fully typed.
  const connect = {
    lookup: createPinnedLookup(hostname, addresses),
  } as unknown as buildConnector.BuildOptions;
  return new Agent({ connect });
}
