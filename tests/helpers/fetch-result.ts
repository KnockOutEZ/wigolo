import type { RawFetchResult, StageError } from '../../src/types.js';
import { isStageError } from '../../src/fetch/error-describe.js';

/**
 * Assert a router fetch produced CONTENT, and narrow to it.
 *
 * `SmartRouter.fetch` returns `RawFetchResult | StageError` in every mode — the terminal
 * challenge guard and the navigation guard do not consult `mode`. A test reading `result.method`
 * or `result.html` is asserting, implicitly, that this particular call took the content path.
 * Saying so explicitly costs one wrapper and buys a real failure message: a router change that
 * starts refusing the fixture URL now reports *that*, instead of `expect(undefined).toBe('http')`
 * leaving you to guess which of the twenty terminal returns fired.
 */
export function expectContent(result: RawFetchResult | StageError): RawFetchResult {
  if (isStageError(result)) {
    throw new Error(
      `expected a content result but the router refused: ${result.error} — ${result.error_reason}`,
    );
  }
  return result;
}

/** The mirror: assert a fetch was refused, and narrow to the stage error. */
export function expectStageError(result: RawFetchResult | StageError): StageError {
  if (!isStageError(result)) {
    throw new Error(
      `expected the router to refuse, but it returned content (${result.method}, status ${result.statusCode})`,
    );
  }
  return result;
}
