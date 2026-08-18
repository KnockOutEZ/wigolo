/**
 * Dependency-closure probe for a PACKAGED artifact.
 *
 * `native-probe.cjs` asks whether the four native packages can dlopen. This asks the question one
 * layer earlier and one layer wider: can the packaged main process reach the ORDINARY JavaScript
 * packages `wigolo` imports at all? The defect it exists for was pure module resolution —
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk' imported from
 * .../node_modules/wigolo/dist/daemon/proxy.js` — with no native code anywhere near it.
 *
 * The anchor is `…/app.asar/out/main/index.js` ON PURPOSE, and it must NOT be "corrected" to the
 * unpacked tree. That archive path is the resolution root the packaged main process actually gets,
 * and it is the one that matters here: resolution from inside the archive consults the archive's own
 * virtual `node_modules` and then `Contents/Resources/node_modules` — it never looks inside
 * `app.asar.unpacked/node_modules`, because that is a SIBLING of the archive and Node only walks up.
 * A probe anchored at the unpacked tree would answer a question nothing asks.
 *
 * Usage:  <electron-binary> closure-probe.cjs <anchor-path>       (with ELECTRON_RUN_AS_NODE=1)
 *
 * Prints one line of JSON on stdout and exits non-zero if any stage failed. Failure is a RESULT
 * here — the negative control needs the message, not a stack trace.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const anchor = process.argv[2];
if (!anchor) {
  process.stderr.write('closure-probe: an anchor path inside the packaged app is required\n');
  process.exit(2);
}

const stages = {};
function stage(name, fn) {
  try {
    const detail = fn();
    stages[name] = { ok: true, detail: String(detail) };
    return true;
  } catch (err) {
    const code = err && err.code ? `[${err.code}] ` : '';
    stages[name] = { ok: false, detail: `${code}${err && err.message ? err.message : String(err)}` };
    return false;
  }
}

/**
 * The `.app` bundle root, derived from the anchor rather than passed in, so it cannot disagree.
 *
 * REALPATHED, and that is load-bearing rather than tidy: the OS temp dir this is staged into is
 * `/var/folders/...`, a symlink to `/private/var/folders/...`, and Node's resolver hands back the
 * resolved form. Comparing the two spellings as strings makes the containment check fail on a
 * correct artifact — a false alarm that would train someone to delete the check.
 */
const bundleRoot = (() => {
  const marker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const at = anchor.indexOf(marker);
  if (at === -1) return null;
  const root = anchor.slice(0, at);
  return fs.existsSync(root) ? fs.realpathSync(root) : root;
})();

const req = createRequire(anchor);
let entry = null;

// `wigolo/studio` is the ONLY external import in the packaged main bundle (everything else is
// `electron` or `node:`), so this is not a sample of the failure — it is the failure.
//
// It cannot go through `require.resolve('wigolo/studio')`: that subpath is published with an
// `import` condition only, and CJS resolution answers ERR_PACKAGE_PATH_NOT_EXPORTED. So the package
// root is found through the one subpath that has no conditions, and the entry is then read out of
// the package's OWN exports map rather than assumed from its directory layout.
stage('resolve', () => {
  let dir = path.dirname(req.resolve('wigolo/studio-db-broker'));
  let manifest = null;
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (parsed.name === 'wigolo') {
        manifest = parsed;
        break;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('no wigolo package.json above the broker entry');
    dir = parent;
  }
  const subpath = manifest.exports?.['./studio']?.import;
  if (typeof subpath !== 'string') throw new Error("wigolo package.json has no exports['./studio'].import");
  entry = path.resolve(dir, subpath);
  return entry;
});

// Resolving is not the property that matters; where it resolved FROM is. Run outside the repository
// this cannot escape, but a run inside one can, and then a broken artifact reports success.
if (entry !== null) {
  stage('containment', () => {
    if (bundleRoot === null) throw new Error(`anchor ${anchor} is not inside a .app bundle`);
    // `entry` lives inside the archive, where realpath goes through Electron's asar layer; if that
    // ever declines, the unresolved path is still a valid thing to test and only ever ADDS a way to
    // fail, never a way to pass.
    let real = entry;
    try {
      real = fs.realpathSync(entry);
    } catch {
      /* keep the unresolved path */
    }
    if (!real.startsWith(bundleRoot + path.sep)) {
      throw new Error(`resolved ${real}, which is OUTSIDE the bundle at ${bundleRoot}`);
    }
    return `inside ${bundleRoot}`;
  });
}

async function main() {
  if (entry !== null) {
    // The whole point: `resolve` only walks the entry package. Loading it pulls the real graph, and
    // every transitive dependency has to be reachable from where the artifact put it.
    try {
      await import(pathToFileURL(entry).href);
      stages.load = { ok: true, detail: `imported ${entry}` };
    } catch (err) {
      const code = err && err.code ? `[${err.code}] ` : '';
      stages.load = { ok: false, detail: `${code}${err && err.message ? err.message : String(err)}` };
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      anchor,
      bundleRoot,
      execPath: process.execPath,
      electron: process.versions.electron ?? null,
      stages,
    })}\n`,
  );
  process.exit(Object.values(stages).every((s) => s.ok) ? 0 : 1);
}

void main();
