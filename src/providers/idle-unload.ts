/**
 * Idle unload for lazily created, memory-heavy providers.
 *
 * The reranker (ONNX cross-encoder) and the embedder (fastembed) stay resident
 * after their last call and hold a few hundred MB of model weights each. A CLI
 * run that searches once and then sits idle keeps that memory for the life of
 * the process, even though the next call may never come.
 *
 * `createIdleUnload` runs `onIdle` once a provider has gone unused for
 * `timeoutMs`. It never fires while a call is in flight: `begin()` opens a
 * window, `end()` closes it, and a timer that expires during a call is re-armed
 * when the call settles.
 *
 * The timer is unref'd, so an armed countdown can never keep the process alive.
 */
import { createLogger } from '../logger.js';

const log = createLogger('providers');

export interface IdleUnloadOptions {
  /** A positive value arms the countdown. Zero, negative, or NaN disables it. */
  timeoutMs: number;
  /** Releases the resident model. Runs at most once per idle window. */
  onIdle: () => void | Promise<void>;
  /** Name used in the debug log line. */
  label?: string;
}

export interface IdleUnload {
  /** Mark the start of a provider call and restart the countdown. */
  begin(): void;
  /** Mark the end of a provider call and restart the countdown. */
  end(): void;
  /** Stop the countdown. A later `begin()` or `end()` arms it again. */
  cancel(): void;
  /** True while a countdown is scheduled. For tests and diagnostics. */
  isArmed(): boolean;
}

export function createIdleUnload(opts: IdleUnloadOptions): IdleUnload {
  const label = opts.label ?? 'provider';
  let timer: NodeJS.Timeout | null = null;
  let inFlight = 0;

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    if (inFlight > 0) return; // busy again: the matching end() re-arms
    void Promise.resolve()
      .then(opts.onIdle)
      .catch((err: unknown) => {
        log.debug('idle unload failed', {
          provider: label,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  function arm(): void {
    clear();
    if (!(opts.timeoutMs > 0)) return;
    timer = setTimeout(fire, opts.timeoutMs);
    timer.unref?.();
  }

  return {
    begin(): void {
      inFlight += 1;
      arm();
    },
    end(): void {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) arm();
    },
    cancel(): void {
      clear();
    },
    isArmed(): boolean {
      return timer !== null;
    },
  };
}

/**
 * Return `provider` with its `method` wrapped in idle bookkeeping.
 *
 * A Proxy is used rather than a plain object so the result keeps the concrete
 * provider's prototype: `instanceof` checks, `dispose`, `warmup` and any other
 * member still resolve exactly as before, and only `method` is intercepted.
 */
export function withIdleTracking<T extends object>(
  provider: T,
  clock: IdleUnload,
  method: string,
): T {
  let bound: ((...args: unknown[]) => Promise<unknown>) | null = null;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop !== method) return Reflect.get(target, prop, receiver);
      bound ??= (...args: unknown[]) => {
        const fn = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
        clock.begin();
        return Promise.resolve(fn.apply(target, args)).finally(() => clock.end());
      };
      return bound;
    },
  });
}