import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // ONE e2e file at a time. Every spec here launches a real browser engine, and vitest's default is
    // to run files in parallel — so the default had several GUI processes competing for the same CPU,
    // GPU and (under xvfb) the same display. Two consequences, one of which is worse than flakiness:
    // a heavily contended machine makes unrelated specs time out, and the parity gate MEASURES frame
    // and timer cadence, which contention silently depresses. A cadence number taken while three
    // other Electron instances are compositing is not a reading of anything.
    fileParallelism: false,
  },
});
