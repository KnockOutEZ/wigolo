import { afterEach, beforeAll, afterAll } from 'vitest';
import net from 'node:net';

/**
 * The suite must never depend on the internet being reachable from the runner.
 *
 * THE DEFECT THIS CLOSES. A test that reaches a live host does not fail — it *measures the
 * host*. `tests/unit/fetch/router-browser-acquire.test.ts` passed for months because
 * `spa.example` and `fail.example` do not resolve, so a rung declined by DNS accident; the one
 * case using `example.com`, which does resolve, served the page and red on ubuntu only. That is
 * the dangerous shape: green everywhere the author looked, and a host difference reported as a
 * behaviour difference.
 *
 * WHY A RECORDER AND NOT ONLY A THROW. Throwing from `connect` is not sufficient on its own,
 * and this was measured rather than assumed: `SmartRouter` catches per-tier fetch failures and
 * escalates (`http fetch failed` … then the next rung), so a thrown fence error is SWALLOWED and
 * the test still goes green — the exact outcome the fence exists to prevent. So every violation
 * is also RECORDED, and the recorded list is asserted empty after each test. A caller may
 * swallow the throw; it cannot swallow the record.
 *
 * WHY `net.Socket.prototype.connect`. It is a prototype method, so the patch is LIVE — looked
 * up at call time rather than captured at import. The measured alternative does NOT work:
 * patching `child_process.spawn` is inert against `import { spawn } from 'node:child_process'`,
 * because a builtin's ESM named exports are snapshotted at first load rather than tracking later
 * reassignment. A fence at that seam could never fire, and a fence that cannot fire is worse
 * than none.
 *
 * EXACTLY WHAT IT COVERS. Four egress paths exist in this codebase, and the answer differs per
 * path. Each row was measured by forcing the egress and reading the result, not reasoned about:
 *
 *   - the default HTTP tier (`httpFetch`, undici) — VISIBLE. Forcing it produced a recorded
 *     `example.com:443` and a red test. This is the path an accidental egress most often takes.
 *   - `node:http` / `net.connect` callers, notably `src/fetch/cdp-client.ts`'s
 *     `http.get(url, { timeout }, cb)` — VISIBLE, but ONLY since the arg-shape fix below. They
 *     were silently sailing through before it.
 *   - the TLS-impersonation tier (`tls-tier.ts`) — INVISIBLE. It egresses through the `wreq-js`
 *     napi backend, whose sockets are opened in native code and never touch `node:net`. Forcing
 *     it produced a real `403` from a live host with the fence installed and silent.
 *   - a browser spawned as a CHILD PROCESS — INVISIBLE. It resolves and connects in its own
 *     process, out of reach of any in-process patch.
 *
 * The two invisible paths are closed the way PR #326 closed them: by stating the precondition at
 * the construction site (`systemBrowserFetch: async () => null`, an injected `tlsFetcher`). This
 * fence does not replace that and must not be read as covering it — which is why the coverage is
 * written down here rather than left to be inferred from a green run.
 *
 * ALSO NOT COVERED: bare DNS. `dns.lookup` / `dns.resolve4` answer over UDP and never construct a
 * `net.Socket`, so a test that only resolves a name is invisible here. That costs nothing for the
 * paths above — the destination is judged BEFORE resolution, so a fenced connect never reaches a
 * resolver — but a test whose assertion depends on a bare lookup would still measure the host.
 *
 * The destination is inspected BEFORE resolution, so a blocked hostname is never looked up.
 * Loopback and unix sockets pass through untouched: the suites that stand up a local server are
 * doing the opposite of the thing this guards.
 */

/** Escape hatch for a test that genuinely must egress. Deliberately verbose, deliberately not a
 *  `WIGOLO_*` name (that namespace is product config, and a spawned child must not inherit this
 *  as if it were), and deliberately absent from every existing suite so applying it is a visible
 *  diff line rather than an accident. */
export const ALLOW_NETWORK_ENV = 'VITEST_WIGOLO_ALLOW_NETWORK';

export interface NetworkViolation {
  host: string;
  port: number;
  /** Call site of the offending connect, for the failure message. */
  stack: string;
  /** Present only for an unclassified arg shape — names WHY it could not be judged, so the fix
   *  is to teach `destinationOf` the shape rather than to widen the allowlist. */
  detail?: string;
}

const violations: NetworkViolation[] = [];

/** Set for the duration of a file that has declared its egress. Scoped with beforeAll/afterAll
 *  rather than assigned at module load because the spawn-serial lane runs every integration file
 *  in ONE fork — a module-level assignment there would silently disarm the fence for whichever
 *  files happened to run afterwards. */
let fileAllowance: string | null = null;

/**
 * Declare that this FILE egresses on purpose, and say why.
 *
 * The reason is mandatory and non-empty by construction, because the failure mode of an escape
 * hatch is that it gets pasted in to make a red go away. Requiring an import, a call, and a
 * written justification makes every use a visible diff line a reviewer can argue with — which is
 * the difference between an inventory of known network dependence and the invisible kind this
 * fence exists to find.
 *
 * Prefer stating the precondition instead wherever the egressing transport is reachable from the
 * test. Reach for this only when it is NOT — a third-party library or a spawned child that opens
 * its own socket cannot be injected from here.
 */
export function allowNetworkInThisFile(reason: string): void {
  if (!reason.trim()) {
    throw new Error('allowNetworkInThisFile requires a reason describing what egresses and why it cannot be stubbed');
  }
  beforeAll(() => {
    fileAllowance = reason;
  });
  afterAll(() => {
    fileAllowance = null;
  });
}

/**
 * Can this destination reach a host on the public internet?
 *
 * The predicate is NOT "is it loopback". It started that way and produced two false positives in
 * the full run, both on suites doing the right thing:
 *
 *   - `tests/unit/daemon/proxy.test.ts` connects to `192.0.2.1` (TEST-NET-1) to force a
 *     connection timeout;
 *   - `tests/unit/fetch/redirect-guard.test.ts` redirects to `10.0.0.5:59999` to prove that
 *     `WIGOLO_FETCH_ALLOW_PRIVATE=1` lets the hop be ATTEMPTED, asserting on the guard's decision
 *     rather than on the network outcome.
 *
 * Neither depends on the internet — both pick a reserved address *because* nothing answers on it,
 * which is the same technique this file's own opt-out control uses. Blocking them would punish
 * the correct pattern.
 *
 * THE LINE THAT KEEPS THIS SAFE: only a LITERAL reserved IP is allowed. A hostname is judged
 * strictly no matter what it looks like, so nothing here can resolve a name — and the defect this
 * fence exists for is a result that depends on NAME RESOLUTION reaching the internet. Widening to
 * reserved literals cannot reintroduce it, because no DNS query is ever made for a literal.
 *
 * ONE HONEST RESIDUAL, stated rather than buried: RFC 1918 space (10/8, 172.16/12, 192.168/16) is
 * unreachable on a laptop but CAN answer on a corporate LAN, so allowing it admits a small
 * host-dependence. It is admitted deliberately — a test about private-address handling has to be
 * able to name a private address, and substituting a documentation range would change which guard
 * branch it exercises. The alternative (block RFC 1918) would force that suite to test something
 * other than what it is for.
 */
function isNonRoutableTarget(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (h.endsWith('.localhost')) return true;

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;

  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false; // a NAME, or an address shape we do not recognise — judged strictly

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local, incl. the cloud metadata endpoint
  if (a === 192 && b === 0 && Number(v4[3]) === 2) return true; // TEST-NET-1 (RFC 5737)
  if (a === 198 && b === 51 && Number(v4[3]) === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && Number(v4[3]) === 113) return true; // TEST-NET-3
  if (a === 0) return true; // "this network"
  return false;
}

/** What a `connect` call resolves to. `unknown` is a real answer, not an absence — see below. */
export type ConnectTarget =
  /** A unix-domain socket. No host to judge, so nothing to fence. */
  | { kind: 'unix' }
  | { kind: 'inet'; host: string; port: number }
  /** A shape this function does not recognize. Treated as a VIOLATION, never as loopback. */
  | { kind: 'unknown'; detail: string };

/**
 * Classify the destination of a `Socket.prototype.connect` call.
 *
 * THE BUG THIS SHAPE EXISTS TO PREVENT, because it already shipped once. The first version
 * returned `{host, port}` or `null`, defaulted a missing host to `'localhost'`, and had no
 * `unknown` case. Two things were wrong with that, and they compounded:
 *
 *  1. Node does NOT hand `connect` the options object for every transport. `net.connect`,
 *     `net.createConnection` and everything in `node:http` pass the result of the internal
 *     `normalizeArgs()` — an ARRAY `[options, callback]` — which `connect` unwraps itself. An
 *     array satisfies `typeof first === 'object'`, so the old code read `.host`/`.port` off the
 *     ARRAY, got `undefined` for both, and fell through to its `'localhost'` default.
 *  2. Defaulting an UNRECOGNIZED shape to `'localhost'` made the failure direction OPEN. The
 *     fence then took its pass-through branch: no throw, no record, real egress.
 *
 * Net effect: `node:http.get` fetched a live page and `net.connect` completed a real TCP
 * connection with the fence installed and silent. A guard that reports "clean" while traffic
 * leaves the box is worse than no guard, because it is believed.
 *
 * So: arrays are unwrapped BEFORE the object branch, and an unrecognized shape now fails CLOSED.
 * `'localhost'` remains the default ONLY where Node itself defaults it — a recognized inet shape
 * carrying a port but no host, which genuinely connects to loopback.
 *
 * Every branch below is pinned by a test row built from args DUMPED FROM A REAL CALL of each
 * transport, not from args written to match this function. Constructing the expected shape by
 * hand is precisely what let the array form go unnoticed.
 */
export function destinationOf(args: unknown[]): ConnectTarget {
  const [first, second] = args;

  // `normalizeArgs()` output: [options, callback]. Recurse rather than special-case, so the
  // object/unix/unknown branches below stay the single source of truth for classification.
  if (Array.isArray(first)) return destinationOf(first);

  if (typeof first === 'string') return { kind: 'unix' }; // connect(path[, listener])

  if (typeof first === 'number') {
    // connect(port[, host][, listener]). Node defaults a missing host to localhost.
    return { kind: 'inet', host: typeof second === 'string' ? second : 'localhost', port: first };
  }

  if (first !== null && typeof first === 'object') {
    const opts = first as { host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
    if (typeof opts.path === 'string') return { kind: 'unix' };

    // `host` is what `connect` itself reads; `hostname` is carried by the `node:http` options and
    // is accepted as a fallback so an http egress is never classified on a missing field.
    const host =
      typeof opts.host === 'string' ? opts.host : typeof opts.hostname === 'string' ? opts.hostname : undefined;
    const port =
      typeof opts.port === 'number' ? opts.port : typeof opts.port === 'string' ? Number(opts.port) : undefined;

    if (host !== undefined || port !== undefined) {
      return { kind: 'inet', host: host ?? 'localhost', port: port ?? 0 };
    }
    return {
      kind: 'unknown',
      detail: `object carrying no host/hostname/port/path (keys: ${Object.keys(opts).slice(0, 8).join(', ') || 'none'})`,
    };
  }

  return { kind: 'unknown', detail: `${first === null ? 'null' : typeof first} argument` };
}

/**
 * The frames worth printing: the first few that are OUR code.
 *
 * A raw stack from inside `connect` is six frames of `node:internal/deps/undici` and names
 * nothing actionable — which is not a cosmetic problem. The whole point of this fence is to hand
 * back the SITE that egressed, and an egress from a transport the test believed it had stubbed
 * is precisely the case where the reader cannot guess it. Node internals and the fence's own
 * frames are dropped; if that leaves nothing, the raw tail is printed rather than an empty
 * string, so the message is never less informative than before.
 */
export function callSiteOf(err: Error): string {
  const frames = (err.stack ?? '').split('\n').slice(1);
  const ours = frames.filter(
    (f) =>
      /\.(ts|tsx|js|mjs|cjs)[:)]/.test(f) &&
      !/\bnode:/.test(f) &&
      !/[/\\]node_modules[/\\]/.test(f) &&
      !/net-fence\.ts/.test(f),
  );
  // Requiring a real file path matters: undici connects from an async continuation whose
  // synchronous stack is `at new Promise (<anonymous>)` and nothing else. Treating that as "our
  // frame" would print a single useless line and DROP the internals that at least name the
  // transport. When no frame identifies a source file, the raw head is strictly more useful.
  return (ours.length > 0 ? ours : frames).slice(0, 6).join('\n');
}

export function networkViolations(): readonly NetworkViolation[] {
  return violations;
}

export function resetNetworkViolations(): void {
  violations.length = 0;
}

/** The message a violating test reds with. Names the destination AND the remedy, because a
 *  fence whose failure reads as flake will be re-run rather than fixed. */
export function violationMessage(list: readonly NetworkViolation[]): string {
  const lines = list.map(
    (v) => `  - ${v.detail ? `<unclassified connect: ${v.detail}>` : `${v.host}:${v.port}`}\n${v.stack}`,
  );
  return (
    `This test attempted ${list.length} outbound connection(s) to a live host. Its result would ` +
    `depend on the machine it ran on, not on the code under test.\n${lines.join('\n')}\n` +
    `Fix it by stating the precondition the test relies on — inject the fetcher/router seam that ` +
    `would otherwise egress. If the egressing transport is NOT reachable from the test (a library ` +
    `or a spawned child that opens its own socket), call allowNetworkInThisFile('<why>') at the ` +
    `top of the file so the dependence is inventoried. ${ALLOW_NETWORK_ENV}=1 disables the fence ` +
    `for a whole run and is for local debugging, not for making a red go away.`
  );
}

let installed = false;

export function installNetworkFence(): void {
  if (installed) return;
  installed = true;

  const original = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    if (fileAllowance !== null || process.env[ALLOW_NETWORK_ENV] === '1') {
      return (original as (...a: unknown[]) => net.Socket).apply(this, args);
    }
    const target = destinationOf(args);
    const allowed =
      target.kind === 'unix' || (target.kind === 'inet' && isNonRoutableTarget(target.host));

    if (!allowed) {
      // Written so the ONLY way to reach the pass-through is to be positively classified as
      // harmless. `unknown` lands here with everything else, which is the fail-closed direction
      // the first version got backwards.
      const where = target.kind === 'inet' ? `${target.host}:${target.port}` : `<unclassified: ${target.detail}>`;
      violations.push({
        host: target.kind === 'inet' ? target.host : '<unclassified>',
        port: target.kind === 'inet' ? target.port : 0,
        stack: callSiteOf(new Error()),
        ...(target.kind === 'unknown' ? { detail: target.detail } : {}),
      });
      // Thrown as well as recorded: a caller that does NOT swallow gets the clear failure
      // immediately, at the call site, which is where it is cheapest to read.
      throw new Error(`[net-fence] blocked outbound connection to ${where}`);
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  afterEach(() => {
    if (violations.length === 0) return;
    const snapshot = violations.slice();
    resetNetworkViolations();
    throw new Error(violationMessage(snapshot));
  });
}
