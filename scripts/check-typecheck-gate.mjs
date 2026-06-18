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
 * Safety-critical modules: NavInterceptor/navigateSession (studio/nav), the act
 * handler + resolver (studio/act, studio/perception/resolve), the single input
 * channel (studio/input, studio/session-control), the control token/epoch
 * (studio/control-token), the session handle (studio/handle), the studio
 * dispatch/auth seam (daemon/studio-dispatch), and the mark layer (studio/mark/* —
 * the structured target, inspector, and store the agent acts on; a wrong target is
 * a wrong action).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Longest alternatives first so e.g. `nav-policy` / `session-control` are not
// shadowed by `nav` / `control-token`.
const SAFETY = /from\s+['"][^'"]*(?:studio\/perception\/resolve|studio\/mark\/target|studio\/mark\/inspect|studio\/mark\/store|studio\/nav-policy|studio\/session-control|studio\/control-token|studio\/nav|studio\/act|studio\/input|studio\/handle|daemon\/studio-dispatch)\.js['"]/;

const cfg = JSON.parse(readFileSync(join(ROOT, 'tsconfig.test.json'), 'utf8'));
const gated = new Set(cfg.include.filter((p) => p.startsWith('tests/')));

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
  const rel = relative(ROOT, file);
  if (SAFETY.test(readFileSync(file, 'utf8')) && !gated.has(rel)) offenders.push(rel);
}

if (offenders.length) {
  console.error('FAIL: tests import a Studio safety-critical module but are NOT in tsconfig.test.json `include`:');
  for (const o of offenders) console.error('  - ' + o);
  console.error('\nAdd each to tsconfig.test.json so a removed/changed safety API fails the type-check gate.');
  process.exit(1);
}
console.log(`OK: all ${gated.size} safety-importing tests are in the type-check gate (tsconfig.test.json).`);
