import { defineConfig } from "vitest/config";

// The site's own suite; without this file vitest would pick up the repo-root
// config (and its product-test setup) one directory up.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
