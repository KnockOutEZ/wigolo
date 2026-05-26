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
import { homedir } from 'node:os';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');
const distEntry = join(projectRoot, 'dist', 'index.js');
const fastembedCache = join(homedir(), '.wigolo', 'fastembed');

const shouldRun = process.env.WIGOLO_E2E_DOCTOR === '1'
  && existsSync(distEntry)
  && existsSync(fastembedCache);

describe.skipIf(!shouldRun)('wigolo doctor — clean exit (E2E)', () => {
  it('exits with a JS-level code (not 134 SIGABRT) even after loading embeddings', () => {
    const r = spawnSync(process.execPath, [distEntry, 'doctor'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, NO_COLOR: '1' },
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
