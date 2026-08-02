import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration + embedded tests spawn a real daemon and make live calls that
    // run from seconds to minutes; the unit tests finish instantly.
    testTimeout: 360_000,
    hookTimeout: 120_000,
    // Spawned-daemon suites bind their own ports; run files sequentially to
    // avoid port/model-cache contention.
    fileParallelism: false,
  },
});
