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
 * EXACTLY WHAT IT COVERS. Three egress paths exist under `src/fetch/`, and the answer differs
 * per path. Each row was measured by forcing the egress and reading the result, not reasoned
 * about:
 *
 *   - the default HTTP tier (`httpFetch`, undici) — VISIBLE. Forcing it produced a recorded
 *     `example.com:443` and a red test. This is the path an accidental egress most often takes.
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

/** Loopback in every spelling Node hands us, plus the unspecified addresses a local listener
 *  binds. Anything else is the public internet as far as this fence is concerned. */
function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Normalize the three `Socket.prototype.connect` overloads to a destination.
 * Returns `null` for a unix-socket connect, which has no host to judge.
 */
export function destinationOf(args: unknown[]): { host: string; port: number } | null {
  const [first, second] = args;
  if (typeof first === 'string') return null; // connect(path[, listener]) — unix socket
  if (typeof first === 'number') {
    const host = typeof second === 'string' ? second : 'localhost';
    return { host, port: first };
  }
  if (first && typeof first === 'object') {
    const opts = first as { host?: string; port?: number; path?: string };
    if (typeof opts.path === 'string') return null; // unix socket
    return { host: opts.host ?? 'localhost', port: opts.port ?? 0 };
  }
  return null;
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
  const lines = list.map((v) => `  - ${v.host}:${v.port}\n${v.stack}`);
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
    const dest = destinationOf(args);
    if (dest && !isLoopback(dest.host)) {
      const stack = callSiteOf(new Error());
      violations.push({ host: dest.host, port: dest.port, stack });
      // Thrown as well as recorded: a caller that does NOT swallow gets the clear failure
      // immediately, at the call site, which is where it is cheapest to read.
      throw new Error(`[net-fence] blocked outbound connection to ${dest.host}:${dest.port}`);
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
