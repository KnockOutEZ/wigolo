/**
 * Why the vector index is (un)available, and what that costs the user.
 *
 * The vector half of the cache is an optional native extension. When it fails
 * to load, everything keeps working except semantic ranking — but the failure
 * was previously silent apart from one `log.warn`, so a user on an unsupported
 * platform saw `find_similar` quietly degrade with no way to learn why. This
 * module turns the raw load error into a diagnosis the `doctor` report can
 * state out loud, including the cases where the honest answer is "nothing you
 * can do on this host".
 *
 * The musl case is the one worth spelling out, because the obvious model of it
 * is wrong. `sqlite-vec` ships five platform packages (`darwin-x64`,
 * `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`) and none is
 * musl-keyed — but none of them declares a `libc` field either, and
 * `process.platform` is `'linux'` for musl and glibc alike. So npm does NOT
 * skip the package on Alpine: it installs the **glibc** `linux-x64` build,
 * `require.resolve()` finds it, and the failure happens later, inside the
 * loader. It is a load failure, not a missing package, which is why detection
 * has to probe the host's libc rather than look for an absent module.
 *
 * Measured on `node:22-alpine` (sqlite-vec 0.1.9 + better-sqlite3 13.0.3): the
 * platform package IS installed, `getLoadablePath()` DOES resolve, and the load
 * then fails with
 *   `Error loading shared library …/vec0.so.so: No such file or directory`
 * — a doubled suffix, and "no such file" about a file that exists. A
 * `node:22-bookworm-slim` control loaded the same extension successfully
 * (`vec_version` -> v0.1.9), which is what pins the cause to musl rather than to
 * a broken package. Note how badly that message would mislead a text-only
 * classifier: it reads exactly like a missing file.
 */

/** Machine-readable cause. `undefined` reason = no load has been attempted yet. */
export type VecUnavailableReason =
  | 'unsupported_platform'
  | 'musl_libc'
  | 'binary_missing'
  | 'load_failed';

export interface VecExtensionStatus {
  loaded: boolean;
  reason?: VecUnavailableReason;
  /** One line naming the cause, user-facing. */
  summary?: string;
  /** What stops working. Never absent when a reason is set. */
  consequence?: string;
  /** What the user can do — or an explicit statement that nothing will help. */
  remedy?: string;
  /** Underlying error text, kept verbatim for bug reports. */
  detail?: string;
}

/**
 * The single consequence sentence. Deliberately shared by every reason: the
 * cause varies, the damage does not, and stating the *unaffected* half matters
 * as much as the affected one — the failure looks total from a `find_similar`
 * call and is not.
 */
const CONSEQUENCE =
  'semantic search falls back to keyword matching (find_similar, hybrid cache ranking, and embedding backfill). Search, fetch, crawl, extract, and the keyword cache are unaffected.';

let muslCache: boolean | undefined;

/**
 * True when the host is Linux with a musl libc (Alpine and friends).
 *
 * `process.platform` cannot answer this — Node reports `'linux'` for both
 * libcs — so the check reads the diagnostic report's `glibcVersionRuntime`,
 * which is populated only when the process is linked against glibc. Absent on
 * Linux therefore means musl. Memoized: the answer cannot change within a
 * process, and building a report is not free.
 */
export function isMuslLinux(): boolean {
  if (muslCache !== undefined) return muslCache;
  if (process.platform !== 'linux') {
    muslCache = false;
    return muslCache;
  }
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    muslCache = !report?.header?.glibcVersionRuntime;
  } catch {
    // Report generation is not guaranteed in every embedding host. Claiming
    // "musl" off a failed probe would put a confident wrong remedy in front of
    // the user, so an unknown libc stays unknown and the caller falls through
    // to the generic `load_failed` diagnosis.
    muslCache = false;
  }
  return muslCache;
}

/** Test seam: drop the memoized libc answer. */
export function resetLibcDetectionForTests(): void {
  muslCache = undefined;
}

/**
 * Process-wide load outcome. This module owns it rather than `db.ts` so that
 * `doctor` can read the diagnosis without importing the DB layer — the doctor
 * tests mock `db.js` wholesale, and routing the status through that mock would
 * mean the reporting path was only ever exercised against a stub.
 */
let status: VecExtensionStatus = { loaded: false };

export function recordVecLoaded(): void {
  status = { loaded: true };
}

/** Classify, remember, and hand back the diagnosis so the caller can log it. */
export function recordVecFailure(err: unknown): VecExtensionStatus {
  status = classifyVecFailure(err);
  return status;
}

/**
 * The current diagnosis. A `loaded: false` with no `reason` means no load has
 * been attempted in this process yet — distinct from a load that was attempted
 * and failed, and callers must not report the two the same way.
 */
export function getVecExtensionStatus(): VecExtensionStatus {
  return status;
}

/**
 * The handle is gone, so nothing is loaded — but any diagnosis is kept.
 *
 * Why the extension could not load is a fact about the host, not about the
 * handle. Discarding it on close would blank the reason for every caller that
 * closes the DB before reporting, which is the normal shape of a health check.
 */
export function recordVecClosed(): void {
  status = { ...status, loaded: false };
}

/** Test seam: return to the "no load attempted" state. */
export function resetVecStatusForTests(): void {
  status = { loaded: false };
}

/**
 * Turn a vector-index load failure into a diagnosis.
 *
 * Order matters. The first two branches key off errors `sqlite-vec` raises
 * itself, before any binary is loaded, so they are decidable from the message
 * alone. Anything that reaches the third branch DID resolve a binary and
 * failed inside the loader — that is where the host's libc becomes the
 * deciding signal rather than the message text, and where an unknown libc must
 * fall through to a generic answer rather than guess.
 */
export function classifyVecFailure(err: unknown): VecExtensionStatus {
  const detail = err instanceof Error ? err.message : String(err);

  if (/unsupported platform for sqlite-vec/i.test(detail)) {
    return {
      loaded: false,
      reason: 'unsupported_platform',
      summary: `no vector-index build exists for ${process.platform}-${process.arch}`,
      consequence: CONSEQUENCE,
      remedy:
        'Supported platforms are macOS (x64/arm64), Linux (x64/arm64, glibc) and Windows (x64). No fix on this host.',
      detail,
    };
  }

  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'MODULE_NOT_FOUND' || /cannot find module/i.test(detail)) {
    return {
      loaded: false,
      reason: 'binary_missing',
      summary: 'the platform-specific vector-index package is not installed',
      consequence: CONSEQUENCE,
      remedy:
        'Reinstall dependencies without `--no-optional`, and on a lockfile built for this platform — the vector index ships as an optional per-platform package.',
      detail,
    };
  }

  if (isMuslLinux()) {
    return {
      loaded: false,
      reason: 'musl_libc',
      summary:
        'the vector index has no musl build for this platform, so the glibc Linux build was installed and the loader rejected it',
      consequence: CONSEQUENCE,
      remedy:
        'No fix on this host. Use a glibc-based image (for example a Debian-slim variant) if you need semantic search.',
      detail,
    };
  }

  return {
    loaded: false,
    reason: 'load_failed',
    summary: 'the vector index is installed but failed to load',
    consequence: CONSEQUENCE,
    remedy: 'Re-run `wigolo warmup`; if it persists, include the detail line above in a bug report.',
    detail,
  };
}
