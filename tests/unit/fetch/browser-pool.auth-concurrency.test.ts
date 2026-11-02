import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetConfig } from "../../../src/config.js";

// Three concurrency properties the auth-seeded context path has to keep:
//   - an authenticated acquire respects maxBrowsers instead of bypassing it,
//   - a failed launch/newContext gives the slot back,
//   - releasing an auth context hands the freed slot to a queued waiter.

const state = {
  newContextCalls: 0,
  failNextContext: false,
  contexts: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
};

vi.mock("playwright", () => {
  const makePage = () => ({
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => "https://example.com",
      headers: () => ({ "content-type": "text/html" }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 20 }),
    content: vi.fn().mockResolvedValue("<html><body>ok</body></html>"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("x")),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  });

  const newContext = vi.fn().mockImplementation(() => {
    state.newContextCalls++;
    if (state.failNextContext) {
      state.failNextContext = false;
      return Promise.reject(new Error("newContext failed"));
    }
    const ctx = {
      newPage: vi.fn().mockResolvedValue(makePage()),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    state.contexts.push(ctx);
    return Promise.resolve(ctx);
  });

  const launch = vi.fn().mockResolvedValue({
    newContext,
    version: () => "142.0.0.0",
    close: vi.fn().mockResolvedValue(undefined),
  });

  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from "../../../src/fetch/browser-pool.js";

interface PoolInternals {
  acquireForType: (
    type: "chromium",
    storageStatePath?: string,
  ) => Promise<unknown>;
  releaseForType: (type: "chromium", ctx: unknown) => void;
  pools: Map<string, { activeCount: number; waitQueue: unknown[] }>;
}

describe("auth-seeded context concurrency", () => {
  beforeEach(() => {
    resetConfig();
    state.newContextCalls = 0;
    state.failNextContext = false;
    state.contexts.length = 0;
    process.env.MAX_BROWSERS = "1";
    resetConfig();
  });

  afterEach(() => {
    delete process.env.MAX_BROWSERS;
    resetConfig();
  });

  it("queues an authenticated acquire at the cap instead of bypassing it", async () => {
    const pool = new MultiBrowserPool();
    const internals = pool as unknown as PoolInternals;

    const first = await internals.acquireForType("chromium", "/tmp/state.json");
    expect(state.newContextCalls).toBe(1);

    let secondSettled = false;
    const second = internals
      .acquireForType("chromium", "/tmp/state.json")
      .finally(() => {
        secondSettled = true;
      });

    await new Promise((r) => setTimeout(r, 20));
    expect(secondSettled).toBe(false);
    expect(state.newContextCalls).toBe(1);
    expect(internals.pools.get("chromium")!.waitQueue).toHaveLength(1);

    // Releasing the first auth context frees the slot; the waiter gets a context.
    internals.releaseForType("chromium", first);
    await expect(second).resolves.toBeDefined();
    expect(state.newContextCalls).toBe(2);

    await pool.shutdown();
  });

  it("gives the slot back when newContext fails", async () => {
    const pool = new MultiBrowserPool();
    const internals = pool as unknown as PoolInternals;

    state.failNextContext = true;
    await expect(
      internals.acquireForType("chromium", "/tmp/state.json"),
    ).rejects.toThrow(/newContext failed/);

    expect(internals.pools.get("chromium")!.activeCount).toBe(0);

    // The slot is available again.
    const ctx = await internals.acquireForType("chromium");
    expect(ctx).toBeDefined();
    expect(state.newContextCalls).toBe(2);

    await pool.shutdown();
  });

  it("does not hand a pooled context to a waiter that needs auth", async () => {
    const pool = new MultiBrowserPool();
    const internals = pool as unknown as PoolInternals;

    // First acquire is authenticated and released (closed, not pooled).
    const authCtx = await internals.acquireForType(
      "chromium",
      "/tmp/state.json",
    );
    internals.releaseForType("chromium", authCtx);

    // A queued authenticated caller now creates its own seeded context.
    const next = await internals.acquireForType("chromium", "/tmp/state.json");
    expect(next).toBeDefined();
    expect(state.newContextCalls).toBe(2);

    await pool.shutdown();
  });
});
