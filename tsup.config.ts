import { defineConfig } from 'tsup';
import { inlineScriptEsbuildPlugin } from './build/inline-script';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  external: ['vite'],
  esbuildPlugins: [inlineScriptEsbuildPlugin()],
});
