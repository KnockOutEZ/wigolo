/**
 * Who owns the live run store for THIS request — and, when it is not us, the raw pipe to the
 * process that does.
 *
 * SD1 mini-spec §6 (decision A-43-5): the run store has exactly ONE live owner at a time — the
 * process hosting the studio gateway when the app is running, else the daemon. SQLite's
 * `BEGIN IMMEDIATE` already serializes writers, so a second appender never corrupts the log; what
 * two owners split is the LIVE FAN-OUT. A tail is fed by the in-process bus (`run-bus.ts`), and a
 * bus only ever sees appends made in its own process, so a client attached to one owner learns
 * about the other's events on RECONNECT (from the durable log) instead of live. Routing every
 * `/v1/runs*` request to the one owner is what closes that.
 *
 * `proxyToStudioHost` (`studio-dispatch.ts`) could not carry this: it is an MCP tool call that
 * buffers a JSON result and never touches a `ServerResponse`. The SSE half needs bytes moved from
 * one socket to another, so this is a raw HTTP pipe — and it PIPES rather than re-serializes
 * precisely so `id:`/`event:`/`data:` framing survives byte-for-byte and `Last-Event-ID` resume
 * still works end to end across the hop.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { readHandle, getMyInstanceId, studioHandlePath, type SessionHandle } from '../../studio/handle.js';
import { createLogger } from '../../logger.js';
import { errorEnvelope, type HttpError } from './errors.js';
import { isLoopbackBind } from './auth.js';

const log = createLogger('rest');

/**
 * Set on every hop this module makes. A request that arrives already carrying it has been proxied
 * once, so proxying it again is a loop — a stale handle pointing at the reader's own endpoint under
 * a different instance id would otherwise ping-pong until a socket runs out.
 *
 * It decides between "proxy" and "fail loud", NEVER between "proxy" and "serve locally". That
 * matters because a caller can forge it: forging it can only fail the forger's own request, where a
 * downgrade to the local store would hand them the split fan-out this whole rule exists to prevent.
 */
export const RUNS_PROXY_HOP_HEADER = 'x-wigolo-runs-proxy';

/** How long the owner has to produce response HEADERS before the hop is called dead. */
const RESPONSE_HEADER_TIMEOUT_MS = 15_000;
/** How long a non-streaming owner response has to finish its body. Streams are exempt by design. */
const BODY_TIMEOUT_MS = 30_000;

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) describe ONE connection. Relaying the owner's framing onto
 * the client's socket would describe a connection that is not theirs — and `content-length` from a
 * response we may re-chunk is the same category of lie.
 *
 * `content-length` is the entry that had to be learned twice. It is not merely redundant: the
 * decline branch below BUFFERS the owner's body and writes its own, which may be shorter than the
 * owner announced (the cap) or a different number of bytes for the same characters (a re-encode).
 * A client handed a length its body does not match either waits for bytes that never come or reads
 * the next response as this one's tail. Node computes our framing correctly from what we actually
 * write; the owner's number can only overrule it with a wrong one.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers that cross the hop. An allowlist rather than a filter: the request may carry a
 * caller's cookies or bearer for a DIFFERENT surface, and forwarding ambient credentials to another
 * process is a widening nobody asked for. `authorization` is set from the handle token instead.
 *
 * `content-length` is deliberately absent, and is the one entry whose absence is load-bearing. It
 * describes THIS hop's body, which is `opts.body` or nothing — never whatever the client announced.
 * Relayed, a bodyless proxied GET carrying a client `Content-Length` leaves the owner's parser
 * waiting for a body on a socket the keep-alive pool immediately hands to the NEXT request, whose
 * opening bytes are then eaten as that body; the owner's parser rejects the remainder and an
 * unrelated caller gets a 502 for a request the owner never saw. One crafted read, one dead victim.
 */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'last-event-id'];

export type RunsOwner =
  | { kind: 'local' }
  | { kind: 'proxy'; endpoint: string; token: string };

interface HandleCacheEntry {
  path: string;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
  handle: SessionHandle | null;
}

let handleCache: HandleCacheEntry | null = null;

/** Test seam — the cache is process-wide, and a row that writes a handle must not inherit another's. */
export function _resetRunsOwnerHandleCache(): void {
  handleCache = null;
}

/**
 * The handle, re-parsed only when the file behind it changed.
 *
 * Ownership is resolved on EVERY `/v1/runs*` request, including each SSE tail's preamble, and the
 * read behind it is synchronous — it blocks the daemon's whole event loop, every other request
 * included. The handle changes at most once per studio launch, so the read was re-deriving a
 * constant per request.
 *
 * The guard is the file's identity, not a clock: `writeHandle` is temp-file + rename, so every
 * republish is a NEW inode and no ttl can be short enough to matter. Nanosecond mtime and size ride
 * along for the case a future writer edits in place. A stat is still one syscall, but it neither
 * parses JSON nor allocates the token — and it is skipped entirely on the studio host, which binds
 * its store and never asks (see `runs.ts`).
 *
 * Liveness is deliberately NOT cached: `processExists` and the endpoint checks below re-run every
 * time, because a host can die without touching its handle and a cached `proxy` answer would send
 * every subsequent request to a dead socket.
 */
function readHandleCached(dataDir?: string): SessionHandle | null {
  const path = studioHandlePath(dataDir);
  let stat: { ino: bigint; mtimeNs: bigint; size: bigint };
  try {
    stat = statSync(path, { bigint: true });
  } catch {
    // No handle file at all — the daemon-is-owner case, and the cheapest one. Nothing to remember.
    handleCache = null;
    return null;
  }

  const cached = handleCache;
  if (cached
    && cached.path === path
    && cached.ino === stat.ino
    && cached.mtimeNs === stat.mtimeNs
    && cached.size === stat.size) {
    return cached.handle;
  }

  const handle = readHandle(dataDir);
  handleCache = { path, ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size, handle };
  return handle;
}

/**
 * The ownership rule, in one place.
 *
 * No handle → nobody else is live, so this process is the owner. A handle whose `instanceId` is
 * MINE means I am the studio host: I serve my own store. Unlike the `studio_*` dispatch, that case
 * is not a refusal — refusing would 5xx the host's own REST surface — it is simply "local", and it
 * is what stops a host proxying to itself.
 *
 * Identity is the collision-resistant instance UUID, never a pid: a dead host leaves a stale handle
 * and the OS reuses its pid, so a pid check would make an unrelated process wrongly claim ownership.
 */
export function resolveRunsOwner(dataDir?: string): RunsOwner {
  const handle = readHandleCached(dataDir);
  // Deliberately NOT `ensureStudioRunning`: `proxyToStudioHost` auto-launches the substrate because
  // a `studio_*` call is meaningless without a browser session, but a `GET /v1/runs` is not — law 2
  // says a run exists whether or not anyone is watching, so a read of the run log must never boot a
  // desktop app. No handle means the daemon is the owner. (A-70-1.)
  if (!handle) return { kind: 'local' };

  const myId = getMyInstanceId();
  if (myId !== null && handle.instanceId === myId) return { kind: 'local' };

  // `readHandle` only checks that `endpoint` is a string, so a truncated or half-written handle
  // reaches here as `''` — which resolves against nothing and would send every run request into the
  // unreachable-owner branch forever. A handle that cannot name a host does not name an owner.
  if (!isUsableEndpoint(handle.endpoint)) {
    log.debug('ignoring studio handle with an unusable endpoint', { endpoint: handle.endpoint });
    return { kind: 'local' };
  }

  // The hop carries the handle's bearer token — and the caller's `Last-Event-ID` — to whatever host
  // the handle names, so where that host may be is worth constraining. The owner is by definition a
  // process on THIS machine (it is what wrote this file), so an endpoint that is not an address of
  // this machine cannot be the owner; it can only be somewhere a credential goes. Writing the handle
  // already needs the same UID, so this is depth rather than a boundary — which is exactly why it is
  // a WARN and not a refusal: the run request is still served, from the local store.
  if (!isThisMachineEndpoint(handle.endpoint)) {
    log.warn('ignoring studio handle whose endpoint is not on this machine', { endpoint: handle.endpoint });
    return { kind: 'local' };
  }

  // A killed host leaves its handle behind — nothing removes it — and the run log outlives it. Read
  // ONLY in the negative direction: no process with that pid means the owner is definitely gone, so
  // this daemon is the owner. It is never read as proof that the host IS alive, because pid reuse
  // makes that direction worthless; that is exactly why IDENTITY still rests on `instanceId`, and a
  // reused pid simply proxies and gets the honest `502` a wrong endpoint deserves.
  if (!processExists(handle.pid)) {
    log.debug('ignoring studio handle whose process is gone', { pid: handle.pid });
    return { kind: 'local' };
  }

  return { kind: 'proxy', endpoint: handle.endpoint, token: handle.token };
}

/**
 * `signal 0` performs the permission and existence checks without delivering anything. `EPERM` means
 * the process exists but belongs to someone else — alive, not absent. A handle carrying no usable
 * pid is treated as alive so this check can only ever ADD a local branch, never remove a proxy one.
 */
function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isUsableEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The wildcard binds. Neither is an address OF anything, but dialing either reaches this machine,
 * and `studio --host 0.0.0.0 --allow-remote` publishes exactly that string as its endpoint.
 */
const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);

/**
 * Whether an endpoint names this machine.
 *
 * Loopback is the common case and reuses the bind gate's predicate rather than a second spelling of
 * it, so the set of hosts we will DIAL cannot drift from the set we are willing to BIND. It is not
 * the whole answer, though: `studio --allow-remote` is a supported bind, and the handle it publishes
 * then names one of this machine's routable addresses — which is still the live owner and must still
 * be proxied to, or the fan-out splits exactly as A-43-5 forbids.
 *
 * No name is resolved, deliberately: a hostname is not an address of this machine as far as this
 * predicate is concerned, so the unknown case fails closed. DNS would also make the answer depend on
 * a resolver the handle's writer may control.
 */
function isThisMachineEndpoint(endpoint: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  if (isLoopbackBind(hostname)) return true;

  // `URL` keeps IPv6 literals bracketed, and a link-local address carries a percent-encoded zone id
  // that names an interface rather than the address.
  const bare = (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname)
    .split('%')[0]
    .toLowerCase();
  if (UNSPECIFIED_HOSTS.has(bare)) return true;

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.address.split('%')[0].toLowerCase() === bare) return true;
    }
  }
  return false;
}

/** Upstream response headers minus the ones that describe our hop rather than the client's. */
function relayHeaders(upstreamRes: IncomingMessage): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstreamRes.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function hostUnreachable(): HttpError {
  return {
    status: 502,
    body: errorEnvelope(
      'studio_host_unreachable',
      'The live run-store owner is not reachable.',
      {
        // Never "delete the handle": the handle is what names the single live owner, and an operator
        // who removes it while the app is up leaves two processes each believing they own the live
        // fan-out — the exact split this route exists to close. Quitting the app is the answer,
        // because that is what makes this daemon the owner honestly.
        hint: 'A studio session handle is published but its endpoint did not answer (stale handle?). '
          + 'Quit or re-launch the studio app so the handle names the live owner; with the app closed '
          + 'this daemon owns the run store.',
      },
    ),
    headers: {},
  };
}

function proxyLoop(): HttpError {
  return {
    status: 502,
    body: errorEnvelope(
      'studio_host_proxy_loop',
      'This run request has already been proxied once.',
      { hint: 'The published studio handle points back at a proxying daemon. Re-launch the studio app so the handle names the live host.' },
    ),
    headers: {},
  };
}

/**
 * What the hop settled as.
 *
 * `owner_declared_no_store` is the one outcome that is not an answer to the client: the owner
 * replied, over an authenticated connection, that it holds no run store. See `DECLINED_BY_OWNER`.
 */
export type RunsProxyOutcome = 'served' | 'owner_declared_no_store';

/**
 * The owner's own words for "I am not a store owner". A `503` carrying this reason is a STATEMENT,
 * not a failure: `runs.ts` sends it when the process has no store to resolve at all.
 *
 * It is the only upstream response that does not become the client's response, and the distinction
 * from the unreachable branch is exactly the one A-70-1 turns on — a refused connect cannot tell
 * "dead" from "busy", but this is a live, authenticated process telling us what it is.
 */
const DECLINED_BY_OWNER = { status: 503, reason: 'store_unavailable' } as const;
/** The declining body is a small error envelope; anything larger is not one and is relayed. */
const DECLINE_BODY_CAP_BYTES = 8 * 1024;

export interface RunsProxyOptions {
  target: { endpoint: string; token: string };
  /** Path AND query exactly as they arrived here — the owner parses the same route we did. */
  path: string;
  method: string;
  /**
   * A pre-read request body to send instead of piping `req`. Set for `POST /v1/runs`, because the
   * request stream can only be consumed once and the fallback below needs to create the run itself.
   */
  body?: Buffer;
  /**
   * The SSE tail. A stream has no body deadline (a healthy tail is silent for minutes) and the
   * socket timeouts on both sides are cleared, which is the same exemption `runs.ts` takes for the
   * in-process tail.
   */
  streaming: boolean;
  /**
   * Override for the non-streaming body deadline. Production never sets it — the constant is the
   * contract. It exists so a stalled owner can be FORCED in a test in milliseconds instead of
   * waited out for thirty seconds, because "we ran it and it did not hang" is not evidence about a
   * branch whose whole failure mode is patience.
   */
  bodyTimeoutMs?: number;
  sendError: (error: HttpError) => void;
}

/**
 * Pipe one `/v1/runs*` request to the live owner and its response back, unchanged.
 *
 * Resolves when the exchange is over — for a stream, that is when the stream dies. The events route
 * runs outside the router's concurrency slot for exactly that reason. Resolves
 * `owner_declared_no_store` instead, having written nothing, when the owner says it holds no store.
 */
export function proxyRunsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunsProxyOptions,
): Promise<RunsProxyOutcome> {
  if (req.headers[RUNS_PROXY_HOP_HEADER] !== undefined) {
    opts.sendError(proxyLoop());
    return Promise.resolve('served');
  }

  let target: URL;
  try {
    target = new URL(opts.path, opts.target.endpoint);
  } catch {
    log.error('studio handle endpoint is not a usable URL', { endpoint: opts.target.endpoint });
    opts.sendError(hostUnreachable());
    return Promise.resolve('served');
  }

  const headers: OutgoingHttpHeaders = {
    Authorization: `Bearer ${opts.target.token}`,
    [RUNS_PROXY_HOP_HEADER]: '1',
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  // The hop's only statement about its own body. A re-serialized body is rarely byte-identical to
  // the one that arrived, and a bodyless hop announces nothing at all.
  if (opts.body) headers['content-length'] = opts.body.length;

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<RunsProxyOutcome>((resolve) => {
    let settled = false;
    /** Cleared here rather than only on the paths that notice: an aborted tail takes none of them. */
    let headerTimer: NodeJS.Timeout | undefined;
    const finish = (outcome: RunsProxyOutcome = 'served'): void => {
      if (settled) return;
      settled = true;
      if (headerTimer) clearTimeout(headerTimer);
      resolve(outcome);
    };

    let upstream: ClientRequest;
    try {
      upstream = send({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: opts.method,
        path: `${target.pathname}${target.search}`,
        headers,
      });
    } catch (err) {
      log.debug('run-store owner request could not be created', { error: String(err) });
      opts.sendError(hostUnreachable());
      finish();
      return;
    }

    // Armed until the owner answers, then cleared. A host that accepts the TCP connection and never
    // replies is the one failure mode a connect-error handler cannot see, and it is indistinguishable
    // from a healthy silent tail once headers HAVE arrived — which is why the deadline covers the
    // headers only.
    headerTimer = setTimeout(() => {
      upstream.destroy(new Error('run-store owner did not send response headers in time'));
    }, RESPONSE_HEADER_TIMEOUT_MS);
    headerTimer.unref?.();

    const fail = (err: unknown): void => {
      // A dead socket reaches us more than once — an `error` on the response and a `close` behind
      // it, or a client hang-up that already resolved this hop. Past the first, there is no status
      // left to choose and `sendError` would write onto a response someone else has finished.
      if (settled) return;
      if (headerTimer) clearTimeout(headerTimer);
      log.debug('run-store owner hop failed', { endpoint: opts.target.endpoint, error: String(err) });
      if (!res.headersSent) opts.sendError(hostUnreachable());
      // Mid-stream there is no status left to change, and ending cleanly would look to the client
      // exactly like a completed stream. Destroying surfaces it as the dropped connection it is, so
      // the client reconnects with its `Last-Event-ID` instead of believing the run went quiet.
      else res.destroy();
      finish();
    };

    upstream.on('error', fail);

    // The client hanging up must reach the owner: a tail whose reader is gone would otherwise stay
    // open on the host, leaking one socket and one bus listener per reconnect.
    const abortUpstream = (): void => {
      if (!upstream.destroyed) upstream.destroy();
      finish();
    };
    res.on('close', abortUpstream);
    req.on('aborted', abortUpstream);

    // `pipe` adds no error listener to its destination, and an 'error' with no listener is an
    // UNHANDLED one — which exits the process with every test still reported passing. The local tail
    // in `runs.ts` registers the same handler on the same reasoning; this path must not be the one
    // that skips it.
    res.on('error', (err) => {
      log.debug('run hop client socket failed', { error: String(err) });
      abortUpstream();
    });
    req.on('error', (err) => {
      log.debug('run hop request stream failed', { error: String(err) });
      abortUpstream();
    });

    if (opts.streaming) {
      res.setTimeout(0);
      req.socket?.setTimeout(0);
    }

    upstream.on('response', (upstreamRes: IncomingMessage) => {
      if (headerTimer) clearTimeout(headerTimer);

      if (res.writableEnded || res.destroyed) {
        upstreamRes.destroy();
        finish();
        return;
      }

      // The one response that is not relayed. Buffered rather than piped because it has to be READ
      // before anything is written to the client — once a status is on the wire the fallback is
      // impossible. Bounded, and only ever entered on a 503.
      if (upstreamRes.statusCode === DECLINED_BY_OWNER.status && !res.headersSent) {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;

        // This is the one branch that stops piping and waits, and waiting is what makes it the one
        // branch with no natural end: a pipe dies with its socket, a buffer does not. The deadline
        // is unconditional — unlike the relay below, which exempts streams because a healthy tail
        // is silent for minutes. A 503 decline is never a tail; it is a bounded error envelope, so
        // an owner that has not finished one in time has stopped rather than gone quiet.
        //
        // Left open, the cost is not just this caller: `runUnderSlotAndDeadline` releases its
        // concurrency slot only when this promise settles, so a hop that never settles spends one
        // of the process's slots permanently, and enough of them close the REST surface until a
        // restart. On the events route there is no route deadline at all, so nothing else would
        // ever notice.
        const declineTimer = setTimeout(() => {
          upstreamRes.destroy(new Error('run-store owner 503 body stalled'));
        }, opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS);
        declineTimer.unref?.();

        upstreamRes.on('data', (c: Buffer) => {
          size += c.length;
          if (size > DECLINE_BODY_CAP_BYTES) { overflow = true; return; }
          chunks.push(c);
        });
        upstreamRes.on('end', () => {
          clearTimeout(declineTimer);
          const body = Buffer.concat(chunks);
          let reason: unknown;
          try { reason = (JSON.parse(body.toString('utf-8')) as { error_reason?: unknown }).error_reason; } catch { /* not an envelope */ }
          if (!overflow && reason === DECLINED_BY_OWNER.reason) {
            log.debug('run-store owner declares it holds no store; serving in-process', { endpoint: opts.target.endpoint });
            finish('owner_declared_no_store');
            return;
          }
          // Some other 503 — a real "temporarily unavailable" from the owner. Relay it as its own,
          // and relay the BYTES: `toString('utf-8')` maps every invalid byte to U+FFFD, which is a
          // different body of a different length from the one the owner sent.
          if (!res.headersSent) {
            res.writeHead(503, relayHeaders(upstreamRes));
            res.end(body);
          }
          finish();
        });
        // Everything the relay branch already handles, and for the same reason: an `error` with no
        // listener is an UNHANDLED one, and a `close` without an `end` is a body that stopped —
        // both of which this branch would otherwise sit on forever. `fail` is the right answer to
        // each: nothing is on the wire yet, and an owner that did not finish a response has told
        // us nothing to relay.
        upstreamRes.on('error', (err) => {
          clearTimeout(declineTimer);
          fail(err);
        });
        upstreamRes.on('close', () => {
          clearTimeout(declineTimer);
          fail(new Error('run-store owner closed its 503 before the body ended'));
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, relayHeaders(upstreamRes));
      // Without this the first frames sit in Node's buffer until enough body accumulates, which on a
      // tail that emits one event a minute is indistinguishable from a stalled stream.
      res.flushHeaders?.();

      let bodyTimer: NodeJS.Timeout | undefined;
      if (!opts.streaming) {
        bodyTimer = setTimeout(() => {
          upstreamRes.destroy(new Error('run-store owner response body stalled'));
        }, opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS);
        bodyTimer.unref?.();
      }

      upstreamRes.on('error', (err) => {
        if (bodyTimer) clearTimeout(bodyTimer);
        log.debug('run-store owner stream failed', { error: String(err) });
        res.destroy();
        finish();
      });
      upstreamRes.on('end', () => {
        if (bodyTimer) clearTimeout(bodyTimer);
      });
      upstreamRes.on('close', finish);

      // `pipe` is the whole contract: the owner's bytes reach the client unexamined, so SSE framing
      // is preserved exactly and backpressure propagates to the owner's socket rather than piling
      // the log into this daemon's heap.
      upstreamRes.pipe(res);
    });

    // Never `req.pipe(upstream)`. Node auto-destroys a stream once it ends, so piping a bodyless GET
    // leaves `req.destroyed` true — and the local handler the no-store fallback hands off to reads
    // exactly that flag to detect a client that gave up, so it would end the response having written
    // no headers at all. Measured: it silently broke the fallback on the SSE tail.
    //
    // Nothing is lost. `/v1/runs*` allows POST on the collection only, and that is precisely the
    // route whose body the caller pre-reads, so a proxied request either carries `body` or carries
    // no body at all.
    if (opts.body) upstream.end(opts.body);
    else upstream.end();
  });
}
