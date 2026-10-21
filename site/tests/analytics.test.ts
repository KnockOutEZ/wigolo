import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// UMAMI_ID is read at import, the way Next inlines NEXT_PUBLIC_* at build time.
async function load(id: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_UMAMI_ID", id);
  return import("../src/lib/analytics");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("track", () => {
  it("sends the event name and properties to Umami", async () => {
    const { track } = await load("site-id");
    const calls: unknown[][] = [];
    const win = { umami: { track: (...a: unknown[]) => (calls.push(a), Promise.resolve()) } };
    await track("sponsor_click", { sponsor: "testmu", placement: "docs" }, 800, win);
    expect(calls).toEqual([["sponsor_click", { sponsor: "testmu", placement: "docs" }]]);
  });

  it("waits for a tag that loads after the call — the sponsor hop fires before it is ready", async () => {
    const { track } = await load("site-id");
    const calls: unknown[][] = [];
    const win: { umami?: { track: (...a: unknown[]) => Promise<void> } } = {};
    const p = track("sponsor_click", { placement: "readme" }, 800, win);
    await vi.advanceTimersByTimeAsync(200);
    win.umami = { track: (...a: unknown[]) => (calls.push(a), Promise.resolve()) };
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(calls).toHaveLength(1);
  });

  it("resolves at the timeout when the tag never loads (blocked), so the hop still forwards", async () => {
    const { track } = await load("site-id");
    let done = false;
    const p = track("sponsor_click", {}, 800, {}).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(799);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it("never rejects, even when the tag throws", async () => {
    const { track } = await load("site-id");
    const win = { umami: { track: () => { throw new Error("blocked"); } } };
    await expect(track("x", {}, 800, win)).resolves.toBeUndefined();
  });

  it("does nothing without a website ID, so local builds send no events", async () => {
    const { track, analyticsEnabled } = await load("");
    const calls: unknown[] = [];
    const win = { umami: { track: (...a: unknown[]) => (calls.push(a), Promise.resolve()) } };
    expect(analyticsEnabled()).toBe(false);
    await track("x", {}, 800, win);
    expect(calls).toHaveLength(0);
  });
});
