import { defineConfig } from 'tsup';

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
});
