/**
 * Friendly diagnosis for a native-addon ABI mismatch (#220, #654).
 *
 * better-sqlite3 ships a compiled `.node` binary built for the Node.js that ran
 * `npm install`. When a different Node later loads it — typically an editor or
 * MCP client launching wigolo with its own bundled Node — the addon fails to
 * load with ERR_DLOPEN_FAILED and a terse "was compiled against a different
 * Node.js version using NODE_MODULE_VERSION X. This version of Node.js requires
 * NODE_MODULE_VERSION Y". These helpers detect that case and turn it into a
 * message that says which Node is running and how to fix it.
 */

const ABI_MISMATCH_RE = /was compiled against a different Node\.js version|NODE_MODULE_VERSION/;

export function isNativeAbiMismatch(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return ABI_MISMATCH_RE.test(err.message);
}

/**
 * Build the actionable explanation for an ABI-mismatch error. `runtime` is
 * injectable for tests; it defaults to the current process.
 */
export function formatNativeAbiMismatch(
  err: Error,
  moduleName = 'better-sqlite3',
  runtime: { version: string; execPath: string; abi: string } = {
    version: process.version,
    execPath: process.execPath,
    abi: process.versions.modules,
  },
): string {
  const versions = [...err.message.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => m[1]);
  const builtFor = versions[0];
  // The addon's on-disk path is quoted in the dlopen message; the directory
  // holding its node_modules is where `npm rebuild` has to run.
  const addonPath = /'([^']+\.node)'/.exec(err.message)?.[1];
  const marker = addonPath ? addonPath.search(/[\\/]node_modules[\\/][^\\/]+[\\/]build[\\/]/) : -1;
  const installDir = addonPath && marker > 0 ? addonPath.slice(0, marker) : undefined;

  const lines = [
    `${moduleName} was built for a different Node.js version than the one running wigolo.`,
    `  Running: Node ${runtime.version} (NODE_MODULE_VERSION ${runtime.abi}) at ${runtime.execPath}`,
    builtFor
      ? `  Installed module was compiled for NODE_MODULE_VERSION ${builtFor}.`
      : '  The installed native module was compiled for another Node.js version.',
    '  This usually means wigolo was installed with one Node and your MCP client/editor launches it with another.',
    '  Fix (any one):',
    `    - rebuild it with Node ${runtime.version} on your PATH: ` +
      (installDir
        ? `cd "${installDir}" && npm rebuild ${moduleName}`
        : `run \`npm rebuild ${moduleName}\` in wigolo's install directory`),
    '    - point your MCP client at the same Node you installed wigolo with',
    '    - or launch via `npx -y wigolo` under the Node your MCP client uses',
  ];
  return lines.join('\n');
}

/**
 * If `err` is an ABI mismatch, return a new Error carrying the friendly
 * message (original kept as `cause`); otherwise return `err` unchanged.
 */
export function explainNativeLoadError(err: unknown, moduleName = 'better-sqlite3'): unknown {
  if (!isNativeAbiMismatch(err)) return err;
  const wrapped = new Error(formatNativeAbiMismatch(err as Error, moduleName), { cause: err });
  (wrapped as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code ?? 'ERR_DLOPEN_FAILED';
  return wrapped;
}
