import { describe, it, expect, vi } from 'vitest';
import { connectScrapingBrowser } from '../../../src/fetch/scraping-browser.js';

/**
 * Both opt-in browser paths could strand a live browser:
 *
 *  - `withTimeoutAndAbort` rejects on timeout/abort, but the underlying
 *    `connect(wss)` keeps running. When it later resolved, the fulfilment
 *    handler saw `settled === true` and returned WITHOUT closing it — a hosted
 *    browser left running on the provider's side, billed, until it timed out
 *    there.
 *  - The pool assigned the hosted browser and then called `newContext()`
 *    outside the try/finally that closes it, so a context failure leaked it.
 */
describe('scraping-browser never strands a browser that arrives late', () => {
  it('closes a browser that connects AFTER the timeout fired', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    let resolveConnect: (b: unknown) => void = () => {};
    const connect = vi.fn(
      () => new Promise((res) => { resolveConnect = res; }),
    ) as never;

    const handle = await connectScrapingBrowser({
      wss: 'wss://user:pass@host.example:9222',
      timeoutMs: 20,
      connect,
    });
    expect(handle).toBeNull(); // timed out

    // The provider answers late. Nothing is waiting for it any more, so the
    // only correct action is to close it.
    resolveConnect({ close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('closes a browser that connects AFTER an abort', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    let resolveConnect: (b: unknown) => void = () => {};
    const connect = vi.fn(
      () => new Promise((res) => { resolveConnect = res; }),
    ) as never;
    const ac = new AbortController();

    const pending = connectScrapingBrowser({
      wss: 'wss://host.example:9222',
      timeoutMs: 5_000,
      connect,
      signal: ac.signal,
    });
    ac.abort();
    expect(await pending).toBeNull();

    resolveConnect({ close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('does NOT close a browser that arrives in time', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn(async () => ({ close })) as never;

    const handle = await connectScrapingBrowser({
      wss: 'wss://host.example:9222',
      timeoutMs: 5_000,
      connect,
    });

    expect(handle).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    await handle!.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
