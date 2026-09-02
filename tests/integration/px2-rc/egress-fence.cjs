/**
 * PX2 RC exit gate — an egress fence for the SPAWNED binary.
 *
 * WHY THIS EXISTS AT ALL. `tests/net-fence.ts` fences the vitest process, and
 * says in as many words that a child process is INVISIBLE to it: the child
 * resolves and connects in its own address space. Every arm of this gate drives
 * a child — the installed `wigolo` — so the suite's own fence cannot see a single
 * request the thing under test makes, and "nothing left the machine" would be an
 * assertion about the wrong process.
 *
 * WHY IT IS NECESSARY AND NOT MERELY BELT-AND-BRACES. `src/server.ts` seeds its
 * engine list with `new BingEngine()` and `new DuckDuckGoEngine()`
 * unconditionally, and `SEARXNG_URL` only UNSHIFTS the sidecar client in front of
 * them. `search` goes through the core provider, but `research`, `agent` and
 * `find_similar` query the engine instances directly — so on an unfenced run they
 * reach Bing and DuckDuckGo, and from there fetch whatever those return.
 * Measured on the first green run of this suite: `research` came back citing
 * Wikipedia and `agent` came back citing microsoft.com. A gate whose own claim is
 * "all-local for the measured arms" cannot be built on engines it does not
 * control, and removing them is a `src/` change this issue has no territory for.
 * So the arms make the claim TRUE by enforcement rather than by hope, and the
 * fence's own record is the evidence.
 *
 * WHY IT RECORDS AS WELL AS THROWS. A throw inside an engine adapter is caught by
 * that adapter's own error handling — that is exactly how a search backend is
 * supposed to survive one engine being down — so a blocked attempt would
 * otherwise leave no trace and the arm could not tell "never tried" from "tried
 * and was stopped". The record is append-only and outside the process's control
 * flow, which is what makes it survive the catch.
 *
 * The chokepoint is `net.Socket.prototype.connect` for the reason the in-process
 * fence gives: it is a live prototype method, so every TCP client above it — the
 * platform `fetch` included — passes through this one patch.
 */

'use strict';

const net = require('node:net');
const { appendFileSync } = require('node:fs');

const RECORD_PATH = process.env.RC_EGRESS_RECORD;

/**
 * Loopback only.
 *
 * Deliberately narrower than `tests/net-fence.ts`, which admits link-local and
 * TEST-NET ranges for tests that need an unreachable address. Nothing in these
 * arms wants one: every server an arm may talk to — the accounts service, its
 * recording front door, the fixture site, the stub engine — binds 127.0.0.1.
 */
function isLoopback(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1') return true;
  // Any 127/8 address, without trusting a regex to parse a dotted quad.
  const parts = h.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    return Number(parts[0]) === 127;
  }
  return false;
}

/**
 * The destination of a `connect` call.
 *
 * Node does not hand `connect` an options object for every transport, so the
 * three accepted shapes are read explicitly and anything unrecognised is treated
 * as a violation rather than as loopback — an unknown destination is the one case
 * where guessing "local" would silently punch a hole in the claim.
 */
function destinationOf(args) {
  const [first, second] = args;

  // THE SHAPE THAT MADE THE FIRST VERSION OF THIS FENCE USELESS. `net.connect`
  // (and `net.createConnection`) run their arguments through Node's internal
  // `normalizeArgs`, which produces an ARRAY — `[options, callback]` — and hand
  // THAT to `Socket.prototype.connect`. An array is `typeof 'object'`, has no
  // `.host`, and so fell into the default below and was classified as
  // `localhost`: the fence allowed every outbound connection while reporting
  // nothing, and the arms were green because they were unfenced. Measured
  // directly: `net.connect(80, '192.0.2.1')` returned without a throw and wrote
  // no record. Unwrap the array first.
  if (Array.isArray(first)) {
    return destinationOf(first);
  }

  if (typeof first === 'object' && first !== null) {
    if (typeof first.path === 'string') return { kind: 'unix', host: first.path };
    // A missing host on a real options object means loopback by Node's own
    // default, but an UNRECOGNISED object must not inherit that leniency.
    if (typeof first.host === 'string') return { kind: 'tcp', host: first.host };
    if (typeof first.port === 'number' || typeof first.port === 'string') {
      return { kind: 'tcp', host: 'localhost' };
    }
    return { kind: 'unknown', host: JSON.stringify(first) };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { kind: 'tcp', host: typeof second === 'string' ? second : 'localhost' };
  }
  if (typeof first === 'string') return { kind: 'unix', host: first };
  return { kind: 'unknown', host: String(first) };
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function fencedConnect(...args) {
  const destination = destinationOf(args);

  // A Unix socket never leaves the machine; it is how the browser engine and the
  // database talk locally, and blocking it would break the arm without making it
  // any more offline.
  if (destination.kind === 'unix' || isLoopback(destination.host)) {
    return originalConnect.apply(this, args);
  }

  if (RECORD_PATH) {
    try {
      appendFileSync(RECORD_PATH, `${destination.kind}\t${destination.host}\n`);
    } catch {
      // A record we cannot write must not become the reason the arm fails
      // differently; the throw below still stops the egress.
    }
  }

  throw new Error(
    `PX2 RC egress fence: blocked a connection to ${destination.host} — the measured arms are all-local`,
  );
};
