# Changelog

## 0.1.1

- Fixed: the manifest of the previous deploy could come from a CDN cache. After two deploys in a row the chunks of the latest one were then not carried, and tabs open on it broke. The manifest is now requested with a unique `?skew=` query and `Cache-Control: no-cache`; assets are requested as before.
- The log now hints at checking `previous` (including the base path) when no manifest is found, since a wrong `previous` looks exactly like the first deploy.

## 0.1.0

Initial release.

- Carries the assets of previous deploys into the new build, using a `skew-manifest.json` published with every deploy. The previous deploy is read from a URL or a local directory.
- Old assets expire by deploy count and by age (`keep`, default 5 deploys / 7 days).
- Every emitted file is tracked, so custom `chunkFileNames` / `assetFileNames` and builds with several outputs (`@vitejs/plugin-legacy`) are covered.
- Carried files never overwrite files of the new build or of `public/`.
- Downloads are retried on network errors, timeouts and 5xx. HTTP 403 for the manifest is treated as the first deploy (S3 without `ListBucket`).
- Injects a small inline script that reloads the page once when a chunk fails to load, with a loop guard, a cancelable `skew:reload` event, and no reload while the browser is offline.
- Supports Vite 5+ and Node 20+.
