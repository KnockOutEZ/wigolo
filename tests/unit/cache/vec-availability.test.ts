/**
 * The vector index is optional and its absence is survivable — which is exactly
 * why a silent failure is expensive. A user whose `find_similar` quietly
 * degraded to keyword matching had no way to learn whether that was a bug, a
 * cold cache, or a platform they could never fix.
 *
 * These tests pin the diagnosis, not the prose: the reason CODE is what the
 * doctor report and any future machine consumer key off, and each reason maps
 * to a materially different user action (change host / reinstall / nothing will
 * help). Getting the wrong code in front of a user is worse than saying
 * nothing, because it sends them to do work that cannot succeed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  classifyVecFailure,
  isMuslLinux,
  resetLibcDetectionForTests,
  recordVecLoaded,
  recordVecFailure,
  getVecExtensionStatus,
  resetVecStatusForTests,
} from '../../../src/cache/vec-availability.js';

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  resetLibcDetectionForTests();
  resetVecStatusForTests();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
  resetLibcDetectionForTests();
  resetVecStatusForTests();
});

describe('libc detection', () => {
  it('never claims musl off Linux, because glibcVersionRuntime is absent there too', () => {
    // The whole hazard: `glibcVersionRuntime` is undefined on macOS and Windows
    // for reasons that have nothing to do with musl. Keying on its absence
    // alone would label every mac an Alpine box.
    setPlatform('darwin');
    expect(isMuslLinux()).toBe(false);
    resetLibcDetectionForTests();
    setPlatform('win32');
    expect(isMuslLinux()).toBe(false);
  });

  it('reports musl when a Linux host has no glibc runtime version', () => {
    setPlatform('linux');
    vi.spyOn(process.report!, 'getReport').mockReturnValue({ header: {} });
    expect(isMuslLinux()).toBe(true);
  });

  it('reports glibc when a Linux host does have one', () => {
    setPlatform('linux');
    vi.spyOn(process.report!, 'getReport').mockReturnValue({
      header: { glibcVersionRuntime: '2.36' },
    });
    expect(isMuslLinux()).toBe(false);
  });

  it('treats an unreadable report as "not musl" rather than guessing musl', () => {
    // Fail-safe direction matters: a wrong `musl` verdict tells the user to
    // change their base image, which is unactionable noise if they are on
    // glibc. An unknown libc falls through to the generic diagnosis instead.
    setPlatform('linux');
    vi.spyOn(process.report!, 'getReport').mockImplementation(() => {
      throw new Error('report unavailable');
    });
    expect(isMuslLinux()).toBe(false);
  });

  it('memoizes, since libc cannot change under a running process', () => {
    setPlatform('linux');
    const spy = vi.spyOn(process.report!, 'getReport').mockReturnValue({ header: {} });
    isMuslLinux();
    isMuslLinux();
    isMuslLinux();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('classifying a load failure', () => {
  it('names an unsupported platform from sqlite-vec\'s own pre-resolution error', () => {
    setPlatform('freebsd');
    const status = classifyVecFailure(
      new Error('Unsupported platform for sqlite-vec, on a freebsd-x64 machine.'),
    );
    expect(status.loaded).toBe(false);
    expect(status.reason).toBe('unsupported_platform');
    expect(status.summary).toContain('freebsd');
    expect(status.remedy).toMatch(/No fix on this host/i);
  });

  it('distinguishes a missing platform package from a broken one', () => {
    // `--no-optional` and a foreign-platform lockfile are both recoverable by
    // reinstalling; a musl mismatch is not. Collapsing them would hand the
    // Alpine user a reinstall instruction that can never work.
    const status = classifyVecFailure(
      new Error("Cannot find module 'sqlite-vec-linux-x64/vec0.so'"),
    );
    expect(status.reason).toBe('binary_missing');
    expect(status.remedy).toMatch(/no-optional/);
  });

  it('classifies by error code as well as message, since resolution errors carry one', () => {
    const err = Object.assign(new Error('something opaque'), { code: 'MODULE_NOT_FOUND' });
    expect(classifyVecFailure(err).reason).toBe('binary_missing');
  });

  it('calls a loader failure on musl what it is: permanent, not a reinstall', () => {
    // MEASURED, not invented. This exact string came out of `node:22-alpine`
    // with sqlite-vec@0.1.9 + better-sqlite3@13.0.3 installed, and a
    // node:22-bookworm-slim control loaded the very same extension fine
    // (`vec_version` -> v0.1.9) — so the failure is musl, not a broken package.
    //
    // Two traps live in that one line, and they are why this test exists:
    //   - the doubled `.so.so`, from SQLite re-probing with an appended suffix;
    //   - the phrase "No such file or directory" about a file that DOES exist.
    // Classifying on message text alone reads that as a missing package and
    // sends the user to reinstall — the same dead end the old "run warmup"
    // advice was. The reason must come from the libc probe instead.
    setPlatform('linux');
    vi.spyOn(process.report!, 'getReport').mockReturnValue({ header: {} });
    const status = classifyVecFailure(
      new Error(
        'Error loading shared library /app/node_modules/sqlite-vec-linux-arm64/vec0.so.so: No such file or directory',
      ),
    );
    expect(status.reason).toBe('musl_libc');
    expect(status.reason).not.toBe('binary_missing');
    expect(status.summary).toMatch(/musl/);
    expect(status.remedy).toMatch(/No fix on this host/i);
  });

  it('does NOT blame musl for a loader failure on a glibc host', () => {
    // The must-not-fire control. `musl_libc` is only honest when the libc probe
    // says so — an arbitrary dlopen failure on Debian is `load_failed`, and its
    // remedy is the opposite advice (retry, then report a bug).
    setPlatform('linux');
    vi.spyOn(process.report!, 'getReport').mockReturnValue({
      header: { glibcVersionRuntime: '2.36' },
    });
    const status = classifyVecFailure(new Error('vec0.so: cannot open shared object file'));
    expect(status.reason).toBe('load_failed');
    expect(status.remedy).toMatch(/warmup/);
  });

  it('never leaves a diagnosed failure without a stated consequence', () => {
    // A reason with no consequence is a code nobody can act on. Every branch
    // must say what the user actually lost.
    setPlatform('linux');
    vi.spyOn(process.report!, 'getReport').mockReturnValue({ header: {} });
    const errors = [
      new Error('Unsupported platform for sqlite-vec, on a freebsd-x64 machine.'),
      new Error("Cannot find module 'sqlite-vec-linux-x64/vec0.so'"),
      new Error('Error loading shared library vec0.so.so: No such file or directory'),
    ];
    for (const err of errors) {
      const status = classifyVecFailure(err);
      expect(status.reason).toBeDefined();
      expect(status.consequence, `reason ${status.reason}`).toBeTruthy();
      expect(status.remedy, `reason ${status.reason}`).toBeTruthy();
    }
  });

  it('keeps the underlying error verbatim so a bug report is still possible', () => {
    const raw = 'Error loading shared library vec0.so.so: No such file or directory';
    expect(classifyVecFailure(new Error(raw)).detail).toBe(raw);
  });

  it('survives a non-Error throw', () => {
    expect(classifyVecFailure('boom').reason).toBe('load_failed');
    expect(classifyVecFailure('boom').detail).toBe('boom');
  });
});

describe('recorded status', () => {
  it('starts with no reason, which means "not attempted" rather than "failed"', () => {
    // The distinction is load-bearing: doctor prints the legacy retry advice
    // for "not attempted" and a real diagnosis for "failed". Collapsing them
    // would make every mocked or DB-less run claim a platform failure.
    const status = getVecExtensionStatus();
    expect(status.loaded).toBe(false);
    expect(status.reason).toBeUndefined();
  });

  it('clears any previous diagnosis on a successful load', () => {
    // A process can re-open the DB (initDatabase closes and reopens). A stale
    // failure surviving a later success would report a working index as broken.
    recordVecFailure(new Error('Error relocating vec0.so'));
    expect(getVecExtensionStatus().reason).toBeDefined();
    recordVecLoaded();
    expect(getVecExtensionStatus()).toEqual({ loaded: true });
  });

  it('remembers the diagnosis and hands it back to the caller for logging', () => {
    const returned = recordVecFailure(new Error("Cannot find module 'sqlite-vec-linux-x64/vec0.so'"));
    expect(returned.reason).toBe('binary_missing');
    expect(getVecExtensionStatus()).toEqual(returned);
  });
});
