import { defineConfig } from 'vitest/config';

/**
 * The conformance lane: it launches a real Studio, so it is gated behind `RUN_STUDIO_E2E` in the spec
 * itself (matching the studio e2e lane's discipline) and is never part of the ordinary unit run.
 *
 * `fileParallelism: false` for the same reason the studio e2e lane sets it: each file here boots a
 * browser engine, and several competing for the same CPU and GPU make unrelated assertions time out.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
