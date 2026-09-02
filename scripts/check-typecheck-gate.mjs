#!/usr/bin/env node
/*
 * Import-driven guard for the Studio safety type-check gate.
 *
 * The gate (tsconfig.test.json) type-checks the set of tests that import a
 * safety-critical Studio module, so a test referencing a removed/changed
 * production symbol fails the build (the cheap check that would have caught the
 * 2C `setPolicy` break and the missing `instanceId`). This guard keeps that set
 * HONEST: it FAILS if any test imports a safety-critical module but is not listed
 * in tsconfig.test.json's `include` — i.e. a new safety-touching test that would
 * otherwise sit outside the type-check and silently go vacuous.
 *
 * Safety-critical modules, after the companion extraction moved the page-driving half of this
 * list into the companion's own repo (where its gate travels with it): the session handle
 * (companion/handle — the trust-on-file bootstrap the whole pairing rests on), the audit
 * retention prune (companion/audit-retention — the one sanctioned deletion path for the forensic
 * log), the artifact provider (companion/artifact-provider — the read that unions companion rows
 * into core results), and the companion contract itself (companion-contract/* — the wire whose
 * refusal arms are the only thing standing between a version skew and a silent mis-pair).
 *
 * P2 adds the prompt-injection trust boundary: security/untrusted (the fence itself — a wrap that
 * silently stops wrapping is an open instruction channel) and server/content-fence (the seam that
 * applies it to every agent-facing result). tests/helpers/untrusted-fence is listed too because the
 * fence assertions are structural and shared through that helper — a test that reaches the boundary
 * only transitively would otherwise sit outside the gate, which is exactly the vacuity this guard
 * exists to prevent.
 *
 * fetch/browser-request-guard is listed for the same reason: it is the per-hop SSRF fence for the
 * browser tier (the tier that used to check the host once, before navigating, and then follow every
 * redirect unattended). A test of a fence that silently stops compiling against the fence is not a
 * test of the fence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Longest alternatives first so e.g. `nav-policy` / `session-control` are not
// shadowed by `nav` / `control-token`.
const SAFETY = /from\s+['"][^'"]*(?:fetch\/browser-request-guard|companion\/handle|companion\/audit-retention|companion\/artifact-provider|companion-contract\/|security\/untrusted|server\/content-fence|helpers\/untrusted-fence)\.js['"]/;

// tsconfig `include` entries are always `/`-separated; `path.relative` yields `\` on win32.
// Compare in POSIX form on both sides or the guard flags EVERY gated file as missing.
const posix = (p) => p.split(sep).join('/');

const cfg = JSON.parse(readFileSync(join(ROOT, 'tsconfig.test.json'), 'utf8'));
const gated = new Set(cfg.include.map(posix).filter((p) => p.startsWith('tests/')));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(join(ROOT, 'tests'))) {
  const rel = posix(relative(ROOT, file));
  if (SAFETY.test(readFileSync(file, 'utf8')) && !gated.has(rel)) offenders.push(rel);
}

if (offenders.length) {
  console.error('FAIL: tests import a Studio safety-critical module but are NOT in tsconfig.test.json `include`:');
  for (const o of offenders) console.error('  - ' + o);
  console.error('\nAdd each to tsconfig.test.json so a removed/changed safety API fails the type-check gate.');
  process.exit(1);
}
console.log(`OK: all ${gated.size} safety-importing tests are in the type-check gate (tsconfig.test.json).`);
