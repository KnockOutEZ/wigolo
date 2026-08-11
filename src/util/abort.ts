// Small AbortSignal combinators for bounding the search content-fetch stage.
// Hand-rolled rather than AbortSignal.any(). The original reason (Node 20.0–20.2
// lack it) no longer applies now the floor is >=22 — these also return a
// `cancel()` that drops the listeners, which AbortSignal.any() does not offer.

export interface CancelableSignal {
  signal: AbortSignal;
  cancel: () => void;
}

/** A per-call timeout as a signal we fully control: aborts with a labeled
 *  TimeoutError DOMException, and `cancel()` clears the timer when the work
 *  settles first (so a fast fetch leaves no pending timer / live controller). */
export function timeoutSignal(ms: number, label: string): CancelableSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(label, 'TimeoutError')),
    ms,
  );
  (timer as NodeJS.Timeout).unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export interface CombinedSignal {
  signal: AbortSignal;
  /** Detach this combiner's listeners from every input. Call when the
   *  consumer settles, so a long-lived shared input (the stage signal)
   *  does not accumulate one listener per fetch. */
  cleanup: () => void;
}

/** Abort when ANY input aborts, propagating that input's `reason`. */
export function anySignal(signals: AbortSignal[]): CombinedSignal {
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  const cleanup = () => {
    while (removers.length) removers.pop()!();
  };
  for (const input of signals) {
    if (input.aborted) {
      controller.abort(input.reason);
      cleanup();
      return { signal: controller.signal, cleanup };
    }
    const handler = () => {
      controller.abort(input.reason);
      cleanup();
    };
    input.addEventListener('abort', handler, { once: true });
    removers.push(() => input.removeEventListener('abort', handler));
  }
  return { signal: controller.signal, cleanup };
}

/** A promise that rejects with `signal.reason` when it aborts; never settles
 *  when no signal is given (so it's a safe loser in a Promise.race). */
export function abortRejection(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;                       // never settles
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
