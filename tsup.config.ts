import { defineConfig } from 'tsup';
import { cpSync, existsSync } from 'node:fs';

export default defineConfig({
  entry: ['src/**/*.ts', 'src/**/*.tsx'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  splitting: false,
  bundle: false,
  clean: true,
  dts: false,
  shims: false,
  onSuccess: async () => {
    if (existsSync('src/scripts')) {
      cpSync('src/scripts', 'dist/scripts', { recursive: true });
    }
  },
});
