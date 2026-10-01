import { defineConfig } from 'vitest/config';
import { inlineScriptVitePlugin } from './build/inline-script.ts';

export default defineConfig({
  plugins: [inlineScriptVitePlugin()],
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        extends: true,
        // Every test builds the app with Vite and drives a real browser.
        test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
      },
    ],
  },
});
