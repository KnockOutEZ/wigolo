/*
 * `SHA256SUMS` — mini-spec §4 G4, plus the one assertion that makes the checksums mean anything:
 * every asset about to be uploaded is byte-identical to the asset its platform's verify job
 * actually ran the M2 battery against.
 *
 * WHY THAT ASSERTION IS NOT CEREMONY. The pipeline builds on one host, verifies on five, and
 * uploads from a sixth. Three artifact hand-offs sit between "the DB opened on linux-arm64" and
 * "these bytes are on the release page", and nothing in a green matrix says the bytes at either
 * end are the same bytes. A re-run of one build job, a `download-artifact` pattern that picks up
 * two copies, a partial upload — each of those ships an unverified artifact under a verified
 * artifact's name, and every job in the run is green. So the verify job records the digest of
 * what it verified, and this step refuses to publish anything whose digest differs.
 *
 * FORMAT IS `sha256sum(1)`'s: `<hex>  <name>`, two spaces, one line per asset, sorted by name.
 * Not a JSON manifest, because the three named consumers (install.sh, the brew formula, a user
 * with curl) verify with `sha256sum -c` / `shasum -a 256 -c` and nothing else. Names are
 * BASENAMES: a path component would make `-c` fail in any directory but the one it was written
 * in, which is every directory a consumer has.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The file body. Sorted by name so two releases of the same asset set produce comparable files
 * and a diff of two `SHA256SUMS` is about the hashes, not about a directory walk's order.
 *
 * @param {Array<{ name: string, sha256: string }>} entries
 */
export function sha256sumsText(entries) {
  return `${[...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}`)
    .join('\n')}\n`;
}

/** Parse one back, so a consumer's `-c` view of the file is testable rather than assumed. */
export function parseSha256sums(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64})\s\s(\S.*)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS line is not \`<hex>  <name>\`: ${JSON.stringify(line)}`);
    entries.push({ sha256: m[1], name: m[2] });
  }
  return entries;
}

/**
 * Reconcile what the plan said should ship, what is on disk, and what each verify job recorded.
 *
 * Returns problems rather than throwing on the first one: a release engineer needs the whole
 * list — "linux-arm64 is missing AND win32-x64's digest changed" is a different incident from
 * either half alone.
 *
 * @param {{ expected: Array<{ target: string, artifact: string }>, assets: Record<string, string>, verified: Record<string, { sha256: string, target: string }> }} input
 */
export function reconcile({ expected, assets, verified }) {
  const problems = [];
  const entries = [];

  for (const { target, artifact } of expected) {
    const file = assets[artifact];
    if (!file) {
      problems.push(`${target}: no asset named ${artifact} was downloaded from the build jobs`);
      continue;
    }
    const actual = sha256File(file);
    const record = verified[target];
    if (!record) {
      problems.push(
        `${target}: ${artifact} has no verify record — mini-spec §3 does not let an unverified ` +
          'artifact ship, so this is a refusal, not a missing nicety'
      );
      continue;
    }
    if (record.target !== target) {
      problems.push(`${target}: the verify record in this slot says target=${record.target}`);
      continue;
    }
    if (record.sha256 !== actual) {
      problems.push(
        `${target}: ${artifact} is ${actual} but the verify job ran against ${record.sha256} — ` +
          'these are different bytes and only one of them was tested'
      );
      continue;
    }
    entries.push({ name: artifact, sha256: actual, target });
  }

  const extra = Object.keys(assets).filter((name) => !expected.some((e) => e.artifact === name));
  for (const name of extra) {
    problems.push(`${name} is present but not in the ship matrix — refusing to publish an asset nothing planned`);
  }

  return { entries, problems };
}

/** Read the JSON records the verify jobs uploaded (one per target), keyed by target. */
export function readVerifiedRecords(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json')) {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (doc.target && doc.sha256) out[doc.target] = { sha256: doc.sha256, target: doc.target };
      }
    }
  };
  walk(dir);
  return out;
}

/** Find each planned artifact anywhere under `dir` — `download-artifact` nests by artifact name. */
export function collectAssets(dir, names) {
  const found = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (names.includes(entry.name)) {
        if (found[entry.name] && found[entry.name] !== p) {
          throw new Error(
            `two files named ${entry.name} were downloaded (${found[entry.name]} and ${p}) — ` +
              'refusing to guess which one the verify job tested'
          );
        }
        found[entry.name] = p;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

function parseArgs(argv) {
  const opts = { plan: null, assets: null, verified: null, out: null, stage: null };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const [flag, inline] = eq === -1 ? [argv[i], null] : [argv[i].slice(0, eq), argv[i].slice(eq + 1)];
    const value = () => inline ?? argv[++i];
    if (flag === '--plan') opts.plan = value();
    else if (flag === '--assets') opts.assets = value();
    else if (flag === '--verified') opts.verified = value();
    else if (flag === '--out') opts.out = value();
    else if (flag === '--stage') opts.stage = value();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  for (const required of ['plan', 'assets', 'verified', 'out']) {
    if (!opts[required]) throw new Error(`--${required} is required`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // The plan is the `verify` matrix the plan job emitted — the same list the verify jobs ran
  // from, read back rather than re-derived, so a mid-run edit to the matrix cannot make the two
  // halves disagree silently.
  const matrix = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  const expected = matrix.include.map((e) => ({ target: e.target, artifact: e.artifact }));

  const assets = collectAssets(opts.assets, expected.map((e) => e.artifact));
  const verified = readVerifiedRecords(opts.verified);
  const { entries, problems } = reconcile({ expected, assets, verified });

  for (const entry of entries) process.stdout.write(`OK    ${entry.name}  ${entry.sha256}\n`);
  if (problems.length > 0) {
    process.stderr.write(`\nREFUSED — ${problems.length} problem(s) between the ship matrix and the artifacts:\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    process.exitCode = 1;
    return;
  }

  const text = sha256sumsText(entries);
  fs.writeFileSync(opts.out, text);
  process.stdout.write(`\nSHA256SUMS (${entries.length} asset(s)) -> ${opts.out}\n${text}`);

  // Stage the assets side by side with SHA256SUMS so `sha256sum -c` runs in one directory and the
  // upload step has one glob instead of five paths.
  if (opts.stage) {
    fs.mkdirSync(opts.stage, { recursive: true });
    for (const entry of entries) fs.copyFileSync(assets[entry.name], path.join(opts.stage, entry.name));
    fs.copyFileSync(opts.out, path.join(opts.stage, 'SHA256SUMS'));
    process.stdout.write(`staged ${entries.length + 1} file(s) in ${opts.stage}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
