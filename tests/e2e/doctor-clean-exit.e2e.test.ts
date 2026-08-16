// E2E regression for the doctor exit-134 (libc++ mutex) crash.
//
// Before the fix, `wigolo doctor` would emit the full diagnostic output
// and then crash on exit with:
//   libc++abi: mutex lock failed: Invalid argument
//   exit 134
//
// The crash originates in onnxruntime-node's global thread-pool tear-down
// during macOS libc++ static destructors and is unrecoverable from JS. The
// fix spawns doctor in a child process whose intended exit code is written
// to a sentinel file; the parent reads the sentinel and exits cleanly.
//
// This test asserts:
//   1. `doctor` exits with a JS-level code (not 134 SIGABRT)
//   2. The diagnostic completes — the "Overall:" line is in stderr
//   3. The cosmetic libc++abi message is stripped from inherited child stderr
//
// Skipped in CI by default — running real doctor requires fastembed/ONNX
// download (~30MB) which is brittle from sandboxes. Enable locally with
// WIGOLO_E2E_DOCTOR=1 once `npx wigolo warmup --embeddings` has populated
// the cache.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

// This test is one of the few that must look at the DEVELOPER'S REAL home rather
// than the harness's throwaway one. Its whole subject is the native ONNX
// thread-pool tear-down, which only happens once a real fastembed model is
// loaded from the real cache that `wigolo warmup --embeddings` populates.
//
// `tests/setup.ts` repoints HOME so no test can write to the real profile. That
// made `homedir()` here resolve to the harness home, where `.wigolo/fastembed`
// never exists — so the gate below became permanently false and this regression
// fence stopped running even for a developer who followed the docblock exactly.
// It reddened nothing and warned nothing.
//
// `os.userInfo().homedir` reads the password database rather than `$HOME`, so it
// still names the real profile under the repointed HOME. Both halves are needed:
// the GATE has to find the real cache, and the CHILD has to be pointed at it too,
// or it starts against an empty data dir and never loads a model.
const REAL_HOME = userInfo().homedir;
const REAL_DATA_DIR = join(REAL_HOME, '.wigolo');

const projectRoot = join(import.meta.dirname, '..', '..');
const distEntry = join(projectRoot, 'dist', 'index.js');
const fastembedCache = join(REAL_DATA_DIR, 'fastembed');

const shouldRun = process.env.WIGOLO_E2E_DOCTOR === '1'
  && existsSync(distEntry)
  && existsSync(fastembedCache);

describe.skipIf(!shouldRun)('wigolo doctor — clean exit (E2E)', () => {
  it('exits with a JS-level code (not 134 SIGABRT) even after loading embeddings', () => {
    const r = spawnSync(process.execPath, [distEntry, 'doctor'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 60000,
      // Undo the harness's HOME repoint for THIS child only. Opt-in
      // (WIGOLO_E2E_DOCTOR=1) and read-dominant: doctor diagnoses, and the point
      // is to load the real cached model so the native tear-down path actually
      // executes. Without this the child inherits the throwaway home, finds no
      // model, and the crash under test can never reproduce.
      env: {
        ...process.env,
        NO_COLOR: '1',
        HOME: REAL_HOME,
        USERPROFILE: REAL_HOME,
        WIGOLO_DATA_DIR: REAL_DATA_DIR,
      },
    });

    // The doctor's intended code is 0 (OK) or 1 (DEGRADED). The crash signature
    // was status === null with signal === 'SIGABRT' (or status === 134 on some
    // shells). Any of those means the fix regressed.
    expect(r.signal).toBeNull();
    expect(r.status).not.toBe(134);
    expect(r.status === 0 || r.status === 1).toBe(true);

    // Diagnostic body must still be present.
    expect(r.stderr).toContain('[wigolo doctor]');
    expect(r.stderr).toMatch(/Overall:\s+(OK|DEGRADED)/);

    // Cosmetic native-teardown noise must be filtered out by the parent.
    expect(r.stderr).not.toContain('libc++abi:');
    expect(r.stderr).not.toContain('mutex lock failed');
  }, 65000);
});
