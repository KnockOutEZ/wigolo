import { build } from 'esbuild';
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
  onSuccess: async () => {
    await build({
      entryPoints: ['src/server/control.ts'],
      outfile: 'dist/server/control.js',
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: true,
      external: ['../server.js'],
      logLevel: 'warning',
    });
  },
});
