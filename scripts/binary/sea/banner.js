/* eslint-disable */
/*
 * SEA BANNER — prepended verbatim to the esbuild CJS bundle. Pairs with `footer.js`, which
 * closes the wrapper this file opens. NEITHER FILE IS VALID JAVASCRIPT ON ITS OWN; together
 * with the bundle between them they are.
 *
 * WHAT A NODE SEA GIVES THE EMBEDDED SCRIPT, AND WHAT IT DOES NOT. It gives one JavaScript
 * blob and a `require` that — Node says so itself, on stderr, on every run — "only supports
 * loading built-in modules". There is no virtual filesystem, no `__filename` that points
 * anywhere real, and no module tree. Everything below exists to hand the bundle back the four
 * things it lost, so that not one line of `src/` has to know it is inside a binary.
 *
 * The four shims, in the order they are built:
 *
 *   1. A REAL `require`, rooted at the artifact's own `libexec/`. Reached from
 *      `realpathSync(process.execPath)`, never `process.execPath` directly — that one
 *      difference is what makes both `mv`-ing the unpacked directory and putting a SYMLINK on
 *      PATH work, which is mini-spec 4 G1 and is checked by a relocation test.
 *
 *   2. A `node:module.createRequire` MONKEY-PATCH. Shim 1 only covers `require` calls the
 *      bundle inherits from this wrapper. Modules that build their own resolver — and several
 *      in `src/fetch/` do, deliberately, to resolve a driver from two different roots — call
 *      `createRequire(...)` themselves and would bypass it entirely.
 *
 *   3. AN ANCHOR for `import.meta.url` / `import.meta.filename`, pointing at a path inside the
 *      mirrored app root. Seven call sites read the package version by walking up from
 *      `import.meta.url` at three different dist depths; anchoring four levels deep in the
 *      mirror makes all three walks land on a real mirrored `package.json`. Three of those
 *      readers use a raw `readFileSync`, which no require shim can intercept — one of them,
 *      inside a `catch`, silently reported `serverInfo.version: "0.0.0"` to every MCP client
 *      during the spike while `--version` printed the right answer.
 *
 *   4. `file://` NORMALIZATION. The bundle is built with `--supported:dynamic-import=false`,
 *      which lowers every `import()` to `require()`. That is what makes bare specifiers reach
 *      the sidecar at all — but a few call sites import a `file:` URL, and `require` does not
 *      take one.
 *
 * NOTHING HERE USES AN ABSOLUTE BUILD-TIME PATH. If you add something that does, the artifact
 * stops being relocatable and the only place that shows up is a user's machine.
 */
const __wigoloModule = require('node:module');
const __wigoloPath = require('node:path');
const __wigoloFs = require('node:fs');
const __wigoloUrl = require('node:url');

/*
 * `realpathSync` — see shim 1. `process.execPath` is the path the process was INVOKED by, so
 * for `~/.local/bin/wigolo -> ~/.wigolo/dist/0.2.1/wigolo/bin/wigolo` (exactly what install.sh
 * creates) it is the symlink, whose parent contains no `libexec` at all.
 */
const __wigoloBinDir = __wigoloPath.dirname(__wigoloFs.realpathSync(process.execPath));
const __wigoloLibexec = __wigoloPath.join(__wigoloBinDir, '..', 'libexec');

/*
 * The anchor. It does not need to exist — `createRequire` and `pathToFileURL` treat a path as
 * a position, not as a file — but the build writes a commented stub there anyway so that
 * anyone who finds this path in a stack trace can read why it is there.
 *
 * Its DEPTH is the load-bearing part: `libexec/app/dist/cli/tui/` puts `..` on `dist/cli`,
 * `../..` on `dist`, and `../../..` on the app root, which are the three depths the mirrored
 * `package.json` copies sit at. A bare-specifier resolution from here walks up through
 * `libexec/app/node_modules` (absent) to `libexec/node_modules` (the sidecar), so the sidecar
 * is found by Node's ordinary ancestor walk rather than by anything clever.
 */
const __wigoloAnchor = __wigoloPath.join(__wigoloLibexec, 'app', 'dist', 'cli', 'tui', '__bundle.cjs');
const __wigoloAnchorDir = __wigoloPath.dirname(__wigoloAnchor);
const __wigoloMetaUrl = __wigoloUrl.pathToFileURL(__wigoloAnchor).href;

const __wigoloBaseRequire = __wigoloModule.createRequire(__wigoloAnchor);

/*
 * A second root, at the sidecar itself. Redundant for a correctly assembled artifact — the
 * ancestor walk above already reaches it — and kept because it is not redundant for a
 * MISASSEMBLED one: it turns "the app mirror is missing" from a resolution failure with a
 * confusing path into a working binary, which is the difference between a broken build being
 * noticed by a size assertion and being noticed by a user.
 */
const __wigoloSidecarRequire = __wigoloModule.createRequire(
  __wigoloPath.join(__wigoloLibexec, 'node_modules', '__sidecar_root__.cjs')
);

function __wigoloNormalize(id) {
  return typeof id === 'string' && id.startsWith('file:') ? __wigoloUrl.fileURLToPath(id) : id;
}

/*
 * Only a RESOLUTION failure falls through to the second root. A module that was found and then
 * threw while executing must propagate that error unchanged — retrying it against another root
 * would either run its side effects twice or replace a real stack trace with a
 * `MODULE_NOT_FOUND` about a path the author never wrote.
 */
function __wigoloIsNotFound(err) {
  return err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND');
}

function __wigoloMakeRequire(base) {
  const wrapped = function (id) {
    const spec = __wigoloNormalize(id);
    try {
      return base(spec);
    } catch (err) {
      if (!__wigoloIsNotFound(err) || base === __wigoloSidecarRequire) throw err;
      return __wigoloSidecarRequire(spec);
    }
  };
  wrapped.resolve = function (id, options) {
    const spec = __wigoloNormalize(id);
    try {
      return base.resolve(spec, options);
    } catch (err) {
      if (!__wigoloIsNotFound(err) || base === __wigoloSidecarRequire) throw err;
      return __wigoloSidecarRequire.resolve(spec, options);
    }
  };
  wrapped.cache = base.cache;
  wrapped.extensions = base.extensions;
  wrapped.main = base.main;
  return wrapped;
}

const __wigoloRequire = __wigoloMakeRequire(__wigoloBaseRequire);

/*
 * Shim 2. `createRequire` is replaced rather than wrapped-per-call-site because the call sites
 * are in `src/` and must stay ignorant of all of this. The ORIGINAL is still used to build the
 * base resolver, so a caller that passes a real on-disk path (the browser-driver seam passes
 * the driver's own `package.json`, wherever it was acquired to) keeps resolving from exactly
 * where it asked to — the sidecar is only ever a fallback, never a redirect.
 */
const __wigoloOrigCreateRequire = __wigoloModule.createRequire;
__wigoloModule.createRequire = function (specifier) {
  let base;
  try {
    base = __wigoloOrigCreateRequire(__wigoloNormalize(specifier));
  } catch {
    base = __wigoloSidecarRequire;
  }
  return __wigoloMakeRequire(base);
};

/*
 * The wrapper. Parameters rather than assignment: `require`, `__filename` and `__dirname` are
 * real bindings in a CommonJS module and reassigning them is a strict-mode TypeError, whereas
 * shadowing them is legal everywhere and reaches every line of the bundle at once.
 *
 * Closed by `footer.js`.
 */
(function (require, __filename, __dirname) {
