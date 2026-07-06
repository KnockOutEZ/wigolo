import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/e2e/**/*.spec.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000 },
});
