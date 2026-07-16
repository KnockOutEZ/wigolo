#!/usr/bin/env node
// Generates assets/legacy-skill-hashes.json — the union of every distinct
// historical byte-set of each canonical skill-pack file, keyed by
// "<pack>/<relPath>". Hashes are computed over EOL-normalized (\r\n -> \n)
// bytes. Historical bytes come from git object history (assets/skills path);
// the three packs added in this slice (cache/diff/watch) have no prior history,
// so their single committed byte-set is included from the current skills/ path.
//
// Regenerate:  node scripts/gen-legacy-skill-hashes.mjs
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GEN_COMMAND = 'node scripts/gen-legacy-skill-hashes.mjs';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
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

// 1) Historical bytes from every commit that changed a file under assets/skills.
const commits = sh('git log --all --format=%H -- assets/skills')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

for (const sha of commits) {
  // List blobs present under assets/skills at this commit.
  let tree;
  try {
    tree = sh(`git ls-tree -r --name-only ${sha} -- assets/skills`);
  } catch {
    continue;
  }
  const files = tree.split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.md'));
  for (const path of files) {
    // path is assets/skills/<pack>/<relPath>
    const rel = path.replace(/^assets\/skills\//, '');
    let buf;
    try {
      buf = execSync(`git show ${sha}:${path}`, { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    add(rel, sha256Normalized(buf));
  }
}

// 2) The three packs added in this slice have no assets/skills history — take
//    their single committed byte-set from the current skills/ tree.
function walk(dir, base) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, base);
    } else if (name.endsWith('.md')) {
      const rel = full.replace(base + '/', '');
      hashes.has(rel) || add(rel, sha256Normalized(readFileSync(full)));
    }
  }
}
for (const pack of ['wigolo-cache', 'wigolo-diff', 'wigolo-watch']) {
  walk(join('skills', pack), 'skills');
}

// Serialize, sorted for stable diffs.
const out = { _comment: `Legacy skill-pack content hashes (sha256 over EOL-normalized bytes), union of all historical byte-sets. Regenerate with: ${GEN_COMMAND}` };
for (const key of [...hashes.keys()].sort()) {
  out[key] = [...hashes.get(key)].sort();
}

writeFileSync('assets/legacy-skill-hashes.json', JSON.stringify(out, null, 2) + '\n', 'utf-8');
console.error(`Wrote ${hashes.size} keys, ${[...hashes.values()].reduce((n, s) => n + s.size, 0)} total hashes`);
