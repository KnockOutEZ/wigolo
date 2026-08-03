import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts?(x)'],
    environment: 'node',
    // Isolates every app unit test from the developer's real ~/.wigolo (see tests/setup.ts).
    setupFiles: ['tests/setup.ts'],
  },
});
