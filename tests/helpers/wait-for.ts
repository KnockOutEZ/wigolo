export interface WaitForOpts {
  timeoutMs: number;
  intervalMs: number;
}

export async function waitFor<T>(
  predicate: () => T | false | undefined | null,
  opts: WaitForOpts,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== false && v !== null && v !== undefined) return v as T;
    await new Promise(r => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms`);
}
