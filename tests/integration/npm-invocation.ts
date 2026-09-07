import { resolveNpmCli } from '../../src/fetch/driver-acquire.js';

/**
 * ⚠ SPAWNING npm FROM A TEST, ON EVERY PLATFORM THE SUITE RUNS ON.
 *
 * `execFileSync('npm', …)` / `spawn('npm', …)` is `ENOENT` on Windows and only on Windows.
 * npm ships there as `npm.cmd`, a batch shim, and libuv's PATH search appends only `.com`
 * and `.exe` — it never consults `PATHEXT` and never goes through a shell. So the process
 * dies at the setup step, before the code under test has run at all, which is exactly the
 * shape of failure that looks like a broken feature and is not one.
 *
 * Naming `npm.cmd` on win32 does not fix it either: since the fix for CVE-2024-27980 Node
 * REFUSES to spawn a `.cmd`/`.bat` without `shell: true`, throwing `EINVAL`. And `shell: true`
 * would trade the crash for a quieter bug — with a shell the arguments are joined back into
 * one string rather than passed as a vector, so the first `--pack-destination` under a
 * `$TMPDIR` containing a space breaks apart silently.
 *
 * What is left is the way `src/` already runs npm (see `resolveNpmCli`'s callers): as a JS
 * entrypoint under `process.execPath`. No shell, no batch file, no quoting, same argv on all
 * three platforms.
 */
export interface NpmInvocation {
  /** The executable to spawn. */
  file: string;
  /** The full argument vector, npm's own entrypoint included where one was resolved. */
  args: string[];
}

/**
 * Build a portable `execFileSync`/`spawn` invocation for an npm subcommand.
 *
 * @param args - npm's own arguments, e.g. `['pack', '--pack-destination', dir]`.
 * @throws when npm's JS entrypoint cannot be located on Windows, where the bare-name
 * fallback is known not to work. Failing here names the cause; falling through would
 * reproduce the original `ENOENT` with nothing explaining it.
 */
export function npmInvocation(args: readonly string[]): NpmInvocation {
  const cli = resolveNpmCli();
  if (cli !== null) return { file: process.execPath, args: [cli, ...args] };
  if (process.platform === 'win32') {
    throw new Error(
      `could not locate npm's own JS entrypoint beside ${process.execPath} — a bare \`npm\` ` +
        'cannot be spawned on Windows (it is npm.cmd, a batch shim), so this arm would die at ' +
        'its setup step rather than test anything',
    );
  }
  // POSIX with an npm that is not laid out next to node — a bare name still resolves there.
  return { file: 'npm', args: [...args] };
}

/**
 * The `symlinkSync` type to use for a directory link.
 *
 * A `'dir'` symlink on Windows needs `SeCreateSymbolicLinkPrivilege`, which an unelevated
 * account without Developer Mode does not hold; a junction needs no privilege at all. Every
 * target we link is already absolute, which is the one thing a junction requires.
 */
export const DIRECTORY_LINK_TYPE: 'dir' | 'junction' =
  process.platform === 'win32' ? 'junction' : 'dir';
