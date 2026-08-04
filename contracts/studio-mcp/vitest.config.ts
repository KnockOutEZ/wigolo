import { defineConfig } from 'vitest/config';

/**
 * The deterministic half of the contract: the drift check and the wire predicates. No Studio, no
 * browser engine, no network — so it belongs in the ordinary test lane and is wired into the root
 * suite as its own project (see the repo-root vitest.config.ts). A drift check that only runs when
 * someone remembers to run it is not a drift check.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
