/**
 * Detects whether the process is running inside a single-file packaged binary
 * (built via @yao-pkg/pkg). pkg sets `process.pkg` and roots the module tree at
 * a virtual `/snapshot` filesystem, so several behaviours must diverge:
 *
 *   - loadable SQLite extensions (sqlite-vec) cannot be dlopen'd out of the
 *     snapshot VFS and must be copied to a real path first (src/cache/db.ts);
 *   - the Ink TUI stack (init --wizard, config TUI) cannot boot inside the
 *     binary because of dependency-level top-level-await, so those entries must
 *     print an actionable headless-fallback message instead.
 *
 * The npm / source path is unaffected: `process.pkg` is undefined there, so
 * every guard keyed on this returns false and behaviour is unchanged.
 */
export function isPackagedBinary(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
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
