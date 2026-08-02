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
 * Actionable message printed when an Ink-only interactive entry (init --wizard,
 * config TUI) is requested inside the standalone binary, where the Ink stack
 * cannot boot. The binary is headless-first (P0 design: the TUI is optional
 * convenience), so we steer the user to the fully-headless flag-driven flow or
 * to running via npm.
 */
export const BINARY_TUI_UNAVAILABLE_MESSAGE =
  'interactive wizard unavailable in the standalone binary — use the flag-driven ' +
  '`wigolo init` (works fully headless) or run via npm (`npx wigolo init --wizard`)';
