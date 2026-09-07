import { isSea } from 'node:sea';

/**
 * Detects whether the process is running inside a single-file packaged binary,
 * of EITHER build. Several behaviours must diverge inside one:
 *
 *   - loadable SQLite extensions (sqlite-vec) cannot be dlopen'd out of a
 *     virtual filesystem and must be copied to a real path first
 *     (src/cache/db.ts);
 *   - the Ink TUI stack (init --wizard, config TUI) cannot boot inside the
 *     binary because of dependency-level top-level-await, so those entries must
 *     print an actionable headless-fallback message instead.
 *
 * TWO SIGNALS, NOT ONE, and the second is why this function was wrong.
 * `process.pkg` is set by @yao-pkg/pkg and by nothing else. A Node
 * single-executable application — the toolchain the binary milestone actually
 * ships (mini-spec DR-9) — leaves it undefined, so every guard keyed on this
 * silently returned FALSE inside the very artifact the guards exist for. The
 * TUI branch is the sharp end: `ink` and `yoga-layout` carry their own
 * top-level await, cannot be required from a CJS bundle at all, and would have
 * thrown a module-level error instead of printing the fallback message.
 *
 * `node:sea.isSea()` is the honest question for the SEA case: unlike an
 * archive path (see `isInsideAppArchive`, where the thing that breaks is
 * whether the OS can resolve a PATH), what breaks here is a property of the
 * HOST — no extractable module tree, no loadable Ink — so a process test is the
 * question that matches the failure. It is a Node builtin and needs no guard:
 * `engines.node` is `>=22` and `node:sea` has existed since 20.12.
 *
 * The npm / source path is unaffected: neither signal fires there, so every
 * guard keyed on this returns false and behaviour is unchanged.
 */
export function isPackagedBinary(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg) || isSea();
}

/**
 * Detects whether `path` points INSIDE a desktop-app archive (`.asar`) — the
 * second virtual filesystem this codebase can be handed a path from, and one
 * `isPackagedBinary()` cannot see: the archive is a normal Node/Electron
 * install, so `process.pkg` is undefined and every guard keyed on it is false.
 *
 * Why a path test rather than a process test. The thing that actually breaks is
 * not "which host am I" but "can the OS resolve this path" — an archive is a
 * single FILE, so any loader that walks the real filesystem gets ENOTDIR at the
 * archive segment. Only the desktop shell's own patched `fs` can see through
 * it, and SQLite's `dlopen` is not routed through that shim. Asking about the
 * path is therefore the honest question, and it stays correct if the same path
 * reaches a plain-Node child (where nothing can read it — see src/cache/db.ts).
 *
 * The alternative signals were rejected: importing `electron` for `app.isPackaged`
 * is forbidden in `src/` (scripts/check-src-no-electron.mjs) and would also be
 * wrong, since a packaged app can run unarchived; and `process.resourcesPath` is
 * set in a plain unpackaged dev run too, so it cannot distinguish the two.
 *
 * Segment-exact on purpose. `app.asar.unpacked/` is the REAL, extracted sibling
 * directory that packaging tools emit, and its contents load normally — a naive
 * `includes('.asar')` would divert exactly the files that were correctly
 * unpacked to fix this very problem. Only a segment whose own name ends in
 * `.asar` counts. Both separators are checked so a Windows path is not missed.
 */
export function isInsideAppArchive(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment.endsWith('.asar'));
}

/**
 * Actionable message printed when an Ink-only interactive entry (init --wizard,
 * config TUI) is requested inside the standalone binary, where the Ink stack
 * cannot boot. The binary is headless-first (P0 design: the TUI is optional
 * convenience), so we steer the user to the fully-headless flag-driven flow or
 * to running via npm.
 */
export const BINARY_TUI_UNAVAILABLE_MESSAGE =
  'interactive wizard unavailable in the standalone binary — use the flag-driven ' +
  '`wigolo init` (works fully headless) or run via npm (`npx wigolo init --wizard`)';

/**
 * The internal verb that makes `process.execPath` usable as a Node interpreter again.
 *
 * THE PROBLEM IT SOLVES. Several call sites spawn `process.execPath` with a FOREIGN JavaScript
 * file as argv[1] — the browser driver's `cli.js`, npm's `npm-cli.js` — because that is the only
 * way to run a JS entrypoint with no shell, no `.cmd`, and no quoting (see the CVE-2024-27980
 * note in `src/fetch/driver-acquire.ts`). Under npm that is exactly right: `process.execPath` IS
 * node. Inside a packaged binary it inverts: `process.execPath` is wigolo, so the child re-enters
 * wigolo's own bundled main and parses the script path as an unknown subcommand. Measured in the
 * spike: `warmup --browser` inside a SEA printed the full help text and reported the binary's own
 * stderr warning as the install error.
 *
 * WHY A VERB AND NOT A STAGED `node`. Shipping a second official Node next to the binary would
 * make the artifact roughly twice the size of the runtime it already embeds — on linux that is
 * the difference between passing the mini-spec 7 budget and blowing it — to run two scripts that
 * the embedded runtime can run perfectly well itself.
 *
 * DELIBERATELY UNDOCUMENTED, and not in `--help`. It is a spawn protocol between wigolo and
 * itself, not a user-facing command; a user who types it gets whatever the script does, which is
 * the same thing they would have got from `node <script>`.
 */
export const RUN_SCRIPT_FLAG = '--run-script';

/**
 * How to spawn `script` on a Node interpreter, from wherever this process happens to be running.
 *
 * The npm/source answer is byte-identical to what these call sites did before — same executable,
 * same argv — so nothing changes off the binary path. Only inside a packaged binary does the
 * re-entry verb appear.
 *
 * Returns the pair rather than spawning, because the callers differ in how they spawn (timeouts,
 * env, a `sudo -n` prefix) and centralising the spawn would mean centralising all of that too.
 */
export function nodeScriptCommand(
  script: string,
  args: readonly string[] = []
): { command: string; args: string[] } {
  return isPackagedBinary()
    ? { command: process.execPath, args: [RUN_SCRIPT_FLAG, script, ...args] }
    : { command: process.execPath, args: [script, ...args] };
}
