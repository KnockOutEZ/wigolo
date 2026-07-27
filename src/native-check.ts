/**
 * WHY: better-sqlite3 is a native addon, so it is bound to the exact Node ABI
 * it was built against. MCP clients routinely run wigolo under a Node that is
 * not the one `npx` used to install it — Cursor, for example, installs with the
 * system Node but runs the server on its own bundled Node. The addon then fails
 * to load and the only thing the user sees is a raw stack or a closed pipe.
 *
 * These helpers turn that class of failure into one sentence that names the two
 * runtimes involved and the way out, and they are shared so `doctor` and the
 * server report the same thing.
 */

export type NativeFailureKind = 'abi-mismatch' | 'missing-binding' | 'other';

export interface NativeFailure {
  kind: NativeFailureKind;
  /** ABI the addon was compiled for, when the error names it. */
  compiledFor?: string;
  /** ABI this process requires, when the error names it. */
  requires?: string;
  /** One-line explanation plus the remedy, ready to print. */
  message: string;
}

/** Cap on the raw linker text echoed back, so a report stays one line. */
const LOADER_MESSAGE_LIMIT = 200;

/** NODE_MODULE_VERSION of the running process, e.g. '137' on Node 24. */
export function currentAbi(): string {
  return process.versions.modules;
}

const ABI_PATTERNS = [/NODE_MODULE_VERSION/i, /was compiled against a different Node\.js version/i];

// Only wording that actually names a failed *lookup* of the binding. A bare
// ERR_DLOPEN_FAILED does not qualify: Node wraps every process.dlopen failure
// in it, including a present-but-unloadable addon (missing shared library,
// unresolved symbol, wrong architecture), and calling those "not downloaded"
// sends the user to reinstall a file that is already there.
const MISSING_PATTERNS = [
  /could not locate the bindings file/i,
  // Anchored to a quoted .node specifier: an unanchored `.*\.node` also matches
  // unrelated missing-JS-module errors whose path merely contains ".node"
  // (e.g. "Cannot find module './foo.nodejs.config.js'").
  /cannot find module ['"][^'"]*\.node['"]/i,
  /no such file or directory.*\.node/i,
  /\.node.*no such file or directory/i,
];

// Generic loader failures: the binding was found but the dynamic linker refused
// it. The linker's own text is the diagnostic, so pass it through rather than
// guessing a cause.
// "image not found" belongs here, not in MISSING_PATTERNS: it is macOS dyld's
// wording for a present-but-unloadable addon (missing dependent .dylib, wrong
// arch) — the binding itself was found.
const LOAD_FAILURE_PATTERNS = [
  /ERR_DLOPEN_FAILED/i,
  /dlopen\(/i,
  /cannot open shared object file/i,
  /image not found/i,
];

/**
 * Pulls the "compiled for X, requires Y" pair out of Node's ABI-mismatch text.
 * Node phrases it as: "...was compiled against a different Node.js version
 * using NODE_MODULE_VERSION 137. This version of Node.js requires
 * NODE_MODULE_VERSION 127."
 */
function parseAbiVersions(text: string): { compiledFor?: string; requires?: string } {
  const versions = [...text.matchAll(/NODE_MODULE_VERSION\s+(\d+)/gi)].map((m) => m[1]);
  if (versions.length >= 2) return { compiledFor: versions[0], requires: versions[1] };
  if (versions.length === 1) return { compiledFor: versions[0], requires: currentAbi() };
  return {};
}

function remedy(moduleName: string): string {
  return (
    `Install ${moduleName} with the same Node that runs wigolo, then point your MCP ` +
    `config at that Node explicitly instead of bare "npx". For example: install into a ` +
    `fixed directory using your client's bundled node, run ` +
    `"npm rebuild ${moduleName}" there, and set the MCP "command" to that node binary ` +
    `with the absolute path to wigolo's dist/index.js as its argument.`
  );
}

/**
 * Classifies a module-load error. Returns undefined when the error is not a
 * native-binding failure, so callers can rethrow untouched.
 */
/**
 * V8 stacks already start with the message, so naively concatenating the two
 * doubles every NODE_MODULE_VERSION occurrence and breaks the "compiled for X,
 * requires Y" pairing. Only append the stack when it does not already carry it.
 */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stack = err.stack ?? '';
  return stack.includes(err.message) ? stack : `${err.message}\n${stack}`;
}

export function describeNativeError(err: unknown, moduleName = 'better-sqlite3'): NativeFailure | undefined {
  const text = errorText(err);

  if (ABI_PATTERNS.some((re) => re.test(text))) {
    const { compiledFor, requires } = parseAbiVersions(text);
    const pair =
      compiledFor && requires
        ? `built for Node ABI ${compiledFor}, but this process needs ABI ${requires}`
        : `built for a different Node ABI than this process (ABI ${currentAbi()})`;
    return {
      kind: 'abi-mismatch',
      compiledFor,
      requires: requires ?? currentAbi(),
      message:
        `${moduleName} was ${pair}. This happens when wigolo is installed by one Node ` +
        `and run by another — a common split between a system Node and the Node bundled ` +
        `with an MCP client. ${remedy(moduleName)}`,
    };
  }

  if (MISSING_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'missing-binding',
      requires: currentAbi(),
      message:
        `${moduleName} has no compiled binding available for this platform and Node ` +
        `(ABI ${currentAbi()}) — the prebuilt binary was not downloaded and no local ` +
        `build succeeded. ${remedy(moduleName)}`,
    };
  }

  if (LOAD_FAILURE_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'other',
      requires: currentAbi(),
      // No ABI-remedy here: reinstalling with a different Node does nothing for
      // a missing system library or a wrong-platform binary. The linker's own
      // text is the diagnosis; the remedy is environmental.
      message:
        `${moduleName} was found but could not be loaded by this Node ` +
        `(ABI ${currentAbi()}). The dynamic linker reported: ${firstLine(text)}. ` +
        `That is usually a missing or outdated system library, or an addon built ` +
        `for another platform or architecture — update the system libraries the ` +
        `linker names, or reinstall wigolo's dependencies on this machine so the ` +
        `addon is built for it.`,
    };
  }

  return undefined;
}

/** First non-empty line of the raw error, trimmed for a one-line report. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.trim().slice(0, LOADER_MESSAGE_LIMIT);
}

/**
 * Wraps a native-load failure in an Error carrying the actionable message,
 * preserving the original as `cause`. Non-native errors pass through unchanged.
 */
export function toActionableNativeError(err: unknown, moduleName = 'better-sqlite3'): unknown {
  const failure = describeNativeError(err, moduleName);
  if (!failure) return err;
  return new Error(failure.message, { cause: err });
}
