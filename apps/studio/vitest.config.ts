import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // `tests/integration/**` holds the specs that straddle the app/core seam: they drive real core
    // modules through the published `wigolo/*` specifiers rather than a mock. Without this second
    // glob they are collected by nothing and the suite reports green having run none of them.
    include: ['tests/unit/**/*.test.ts?(x)', 'tests/integration/**/*.test.ts?(x)'],
    environment: 'node',
    // Isolates every app unit test from the developer's real ~/.wigolo (see tests/setup.ts).
    setupFiles: ['tests/setup.ts'],
  },
});
