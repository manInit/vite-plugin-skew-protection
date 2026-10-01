import { defineConfig } from 'vite';
// The package imports itself by name, so this resolves to `../dist`: run `pnpm build` first.
import skewProtection from 'vite-plugin-skew-protection';

// Baked into every chunk, so each deploy gets new file hashes even when the code didn't change.
const buildTime = Date.now();
const buildId = buildTime.toString(36);

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    skewProtection({
      // `previous` comes from SKEW_PREVIOUS_URL, see `.github/workflows/demo.yml`.
      // The page finds its own deploy in the manifest by this id.
      buildId,
      // The demo is deployed every hour: a tab stays protected for a day.
      keep: { deploys: 24, days: 7 },
      // A deploy without the old chunks would break the tabs that are waiting for it. Better no deploy at all.
      strict: true,
      // Left out on purpose, to show what happens when a chunk is gone (the reload).
      include: (fileName) => !fileName.includes('not-carried'),
    }),
  ],
});
