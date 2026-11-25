#!/usr/bin/env node
// Generates assets/legacy-skill-hashes.json — the union of every distinct
// byte-set of each skill-pack file that wigolo has shipped, keyed by
// "<pack>/<relPath>". Hashes are computed over EOL-normalized (\r\n -> \n)
// bytes. The output is a superset of three sources:
//   1. the hashes already in the manifest (earlier releases recorded these, and
//      some of them are no longer reachable from git history),
//   2. every byte-set in git history under assets/skills/ and skills/,
//   3. the current skills/ tree, which is what the next release replaces.
// Re-running it never drops a hash.
//
// Regenerate (from the repo root):  node scripts/gen-legacy-skill-hashes.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const GEN_COMMAND = 'node scripts/gen-legacy-skill-hashes.mjs';
const MANIFEST = join('assets', 'legacy-skill-hashes.json');
const SKILL_ROOTS = ['assets/skills', 'skills'];

function git(args, encoding = 'utf-8') {
  return execFileSync('git', args, { encoding, maxBuffer: 64 * 1024 * 1024 });
}

function sha256Normalized(buf) {
  const norm = Buffer.from(buf.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8');
  return createHash('sha256').update(norm).digest('hex');
}

// Map of "<pack>/<relPath>" -> Set<hash>
const hashes = new Map();
function add(key, hash) {
  if (!hashes.has(key)) hashes.set(key, new Set());
  hashes.get(key).add(hash);
}

// 1) Keep every hash the manifest already records.
if (existsSync(MANIFEST)) {
  const prior = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  for (const [key, list] of Object.entries(prior)) {
    if (key === '_comment' || !Array.isArray(list)) continue;
    for (const hash of list) add(key, hash);
  }
}

// 2) Every byte-set in git history under each skill root.
for (const root of SKILL_ROOTS) {
  const commits = git(['log', '--all', '--full-history', '--format=%H', '--', root])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sha of commits) {
    let tree;
    try {
      tree = git(['ls-tree', '-r', '-z', '--name-only', sha, '--', root]);
    } catch {
      continue;
    }
    const files = tree.split('\0').filter((f) => f.endsWith('.md'));
    for (const path of files) {
      let buf;
      try {
        buf = git(['show', `${sha}:${path}`], 'buffer');
      } catch {
        continue;
      }
      add(path.slice(root.length + 1), sha256Normalized(buf));
    }
  }
}

// 3) The current skills/ tree, including uncommitted edits.
function walk(dir, base) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, base);
    } else if (name.endsWith('.md')) {
      add(relative(base, full).split(sep).join('/'), sha256Normalized(readFileSync(full)));
    }
  }
}
if (existsSync('skills')) walk('skills', 'skills');

// Serialize, sorted for stable diffs.
const out = { _comment: `Legacy skill-pack content hashes (sha256 over EOL-normalized bytes), union of all historical byte-sets. Regenerate with: ${GEN_COMMAND}` };
for (const key of [...hashes.keys()].sort()) {
  out[key] = [...hashes.get(key)].sort();
}

writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n', 'utf-8');
console.error(`Wrote ${hashes.size} keys, ${[...hashes.values()].reduce((n, s) => n + s.size, 0)} total hashes`);
