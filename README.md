# vite-plugin-skew-protection

[![npm](https://img.shields.io/npm/v/vite-plugin-skew-protection)](https://www.npmjs.com/package/vite-plugin-skew-protection)
[![CI](https://github.com/manInit/vite-plugin-skew-protection/actions/workflows/ci.yml/badge.svg)](https://github.com/manInit/vite-plugin-skew-protection/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/vite-plugin-skew-protection)](./LICENSE)

**Stop `Failed to fetch dynamically imported module` after every deploy.**

Keeps the chunks that open tabs still need on _any_ static host (GitHub Pages, Netlify, Cloudflare Pages, S3, nginx in Docker…), and reloads the page once if a chunk is gone anyway.

![Left: without the plugin the old tab breaks after a deploy. Right: with the plugin it keeps working.](./demo.gif)

**[Live demo](https://maninit.github.io/vite-plugin-skew-protection/)** on GitHub Pages, redeployed every hour: open it, wait for the next deploy, press the button. The old tab loads a chunk that the new build no longer has. Source: [`demo/`](./demo), deployed by [`demo.yml`](./.github/workflows/demo.yml).

```bash
npm i -D vite-plugin-skew-protection
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import skewProtection from 'vite-plugin-skew-protection';

export default defineConfig({
  plugins: [
    skewProtection({
      previous: 'https://my-app.com/', // where the current version is live
    }),
  ],
});
```

That's it. No server, no CDN setup, no code changes in your app. Works with Vite 5 and newer on Node 20+.

## The problem

1. A user opens your app. Their tab knows chunk names like `settings-C39H5CxR.js`.
2. You deploy. File hashes change and the host deletes the old files.
3. The user clicks a lazy route in the old tab → the browser asks for `settings-C39H5CxR.js` → **404 → blank screen** and a flood of errors in Sentry.

This is called _version skew_. Vite's docs [describe it](https://vite.dev/guide/build#load-error-handling) and leave the fix to you. Vercel has [skew protection](https://vercel.com/docs/skew-protection) built in (with some [wiring needed for Vite](https://github.com/vitejs/vite/discussions/23196)); everywhere else you're on your own.

## How it works

**1. Carry old chunks forward.** Every build publishes a small `skew-manifest.json` listing its assets. On the next build the plugin reads the manifest from your live site, downloads the files the new build no longer has, and puts them into the new `dist`. Old tabs keep loading their chunks; new visitors get the new ones. Old files expire after 5 deploys or 7 days (configurable), so `dist` doesn't grow forever.

```
build v3 ──reads──▶ https://my-app.com/skew-manifest.json   (v2 + v1 assets)
         ──copies─▶ assets v1/v2 that v3 doesn't have → dist/assets/
         ──writes─▶ dist/skew-manifest.json                 (v3 + v2 + v1)
```

**2. Recover as a last resort.** A tiny inline script (~0.9 kB, ~0.5 kB gzipped) catches chunk load errors (`vite:preloadError`, and the Chrome / Firefox / Safari variants of the dynamic import error) and reloads the page once, keeping the URL. If the reload doesn't help, it stops instead of looping. It stays idle while the browser is offline: a reload wouldn't bring the chunk back.

The two layers don't depend on each other. When layer 1 did its job, the old chunk is there, nothing fails and the script stays idle. Layer 2 only kicks in when the chunk really is gone: on the first protected deploy, after the file expired, when the build couldn't reach `previous`, or with `previous: false`. The reload fetches a fresh `index.html`, and the tab moves to the new version.

```
old tab clicks a lazy route after a deploy
├─ chunk was carried forward → 200, the tab keeps working on its version, no reload
└─ chunk is gone             → 404 → skew:reload → reload → the tab is on the new version
                                       └─ fails again within cooldownMs → stop, no loop
```

Both layers are tested end-to-end in a real browser against a host that deletes old files on every deploy: see [`test/e2e/skew.test.ts`](./test/e2e/skew.test.ts).

## Setup checklist

- **Serve `index.html` with `Cache-Control: no-cache`.** Otherwise browsers keep an old HTML that points at old chunks for a long time. Most static hosts already do this.
- **`skew-manifest.json` must be publicly reachable** next to your `index.html`. It only contains file names.
- **The first protected deploy has nothing to carry.** Protection starts working from the second deploy with the plugin.
- **Your CI must be able to reach `previous`.** If it can't (private network, preview builds), use a local directory instead — see below.

## Recipes

**GitHub Pages / Netlify / Cloudflare Pages / S3** — point `previous` at the production URL, including the base path:

```ts
skewProtection({ previous: 'https://user.github.io/my-repo/' });
```

On S3 (and other object storage) without the `s3:ListBucket` permission a missing file is answered with 403, not 404. The plugin treats a 403 for `skew-manifest.json` as "no manifest yet" and logs a warning, so the first deploy works there too. If your site is behind authorization, a 403 means the credentials are missing: pass them in `headers`.

**Only protect production builds** — read the URL from an env var so preview builds don't carry production files:

```ts
skewProtection(); // uses process.env.SKEW_PREVIOUS_URL when set
```

```yaml
# GitHub Actions
- run: npm run build
  env:
    SKEW_PREVIOUS_URL: ${{ github.ref == 'refs/heads/main' && 'https://my-app.com/' || '' }}
```

**Docker / nginx / no network in CI** — keep the previous `dist` around (a CI cache, a volume, a previous image) and point at the directory:

```ts
skewProtection({ previous: './.skew-cache' }); // e.g. a copy of the last deployed dist
```

**Recovery only** — no carrying, just the one-time reload:

```ts
skewProtection({ previous: false });
```

## Options

| Option             | Default                         | Description                                                                                                                                 |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `previous`         | `process.env.SKEW_PREVIOUS_URL` | URL of the live site or a local directory with the previous build. `false` disables carrying.                                               |
| `keep`             | `{ deploys: 5, days: 7 }`       | Keep old files for this many previous deploys, but no longer than this many days.                                                           |
| `recover`          | `true`                          | Inject the reload-once script. `{ cooldownMs }` sets the loop guard window (default `10000`).                                               |
| `strict`           | `false`                         | Fail the build if `previous` can't be reached. By default it warns and builds anyway. A missing manifest (404, 410, 403) is never an error. |
| `include`          | every emitted file              | Which emitted files count as versioned assets worth carrying. HTML, the manifest and `.vite/` are never carried.                            |
| `buildId`          | commit SHA from CI or random    | Id recorded in the manifest. Also read from `SKEW_BUILD_ID`.                                                                                |
| `headers`          | —                               | Extra request headers, e.g. basic auth for a protected staging site.                                                                        |
| `concurrency`      | `8`                             | Parallel downloads.                                                                                                                         |
| `timeoutMs`        | `15000`                         | Request timeout. A request that fails with a network error, a timeout or 5xx is tried 3 times.                                              |
| `manifestFileName` | `skew-manifest.json`            | Name of the published manifest.                                                                                                             |

The plugin never overwrites a file that is already in the new build: files of the new build and of `public/` always win over carried ones.

**CommonJS config** — the plugin is the default export:

```js
const skewProtection = require('vite-plugin-skew-protection').default;
```

## Hooks for your app

**Show your own message instead of reloading** — the plugin dispatches a cancelable `skew:reload` event first:

```ts
window.addEventListener('skew:reload', (event) => {
  if (userHasUnsavedChanges()) {
    event.preventDefault(); // no automatic reload
    showToast('A new version is available. Save your work and refresh.');
  }
});
```

**Keep Sentry quiet during the reload:**

```ts
Sentry.init({
  beforeSend(event) {
    return window.__SKEW_PROTECTION__?.reloading ? null : event;
  },
});
```

## FAQ

**Does it make deploys bigger?** Only by the chunks that actually changed in the last few deploys, and only until they expire. Unchanged chunks keep their names and aren't duplicated.

**Does it work with React, Vue, Svelte, Solid…?** Yes. It works on Vite's output, so the framework doesn't matter. It targets client builds (SPA/MPA); SSR builds are skipped.

**Does it work with `@vitejs/plugin-legacy` or several `output`s?** Yes. The files of every output are recorded as one deploy and carried together.

**I changed `chunkFileNames` / `assetFileNames`.** That's fine: every emitted file is tracked wherever it lives, not only the ones in `build.assetsDir`. Use `include` to narrow it down.

**I use SvelteKit / Nuxt / Remix.** Those frameworks ship their own version handling, and their server-rendered pages don't always go through Vite's `index.html`. The carry-forward part still helps if you deploy their client output to a static host, but check your framework's docs first.

**I have a strict CSP without `unsafe-inline`.** Use `recover: false` and add your own `vite:preloadError` handler, or allow the script by its hash.

**How is this different from "new version available" plugins?** They tell the user to reload. This plugin makes the old tab keep working, so the user can finish what they were doing. You can use both.

## Development

```bash
pnpm install
pnpm check             # typecheck + oxlint + oxfmt --check + unit tests
pnpm test:e2e          # browser scenarios: without plugin / carry / recover / cancel / offline / loop guard
pnpm test:compat 5     # packed tarball + Vite 5 (or 6, 7): two builds in a row, needs `pnpm build` first
pnpm check:package     # build, then publint + are-the-types-wrong on the packed tarball
pnpm demo:build        # the live demo from `demo/`, needs `pnpm build` first
pnpm lint:fix          # oxlint autofixes
pnpm format            # oxfmt
```

## License

MIT
