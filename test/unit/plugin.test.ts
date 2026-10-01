import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type BuildOptions } from 'vite';
import skewProtection, { type SkewManifest, type SkewProtectionOptions } from '../../src/index';

let work: string;

const DEFAULT_HEAD = '<title>t</title>';

interface AppOverrides {
  /** Extra `build` options for Vite. */
  build?: BuildOptions;
  /** Contents of `<head>` in index.html. */
  head?: string;
  /** Files to put into `public/`, name -> contents. */
  publicFiles?: Record<string, string>;
}

async function writeApp(dir: string, version: string, overrides: AppOverrides) {
  await mkdir(join(dir, 'public'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html><head>${overrides.head ?? DEFAULT_HEAD}</head><body><script type="module" src="./main.js"></script></body></html>`,
  );
  for (const [name, contents] of Object.entries(overrides.publicFiles ?? {})) {
    await writeFile(join(dir, 'public', name), contents);
  }
  await writeFile(join(dir, 'main.js'), `document.body.dataset.ready = '1'\nwindow.load = () => import('./page.js')\n`);
  await writeFile(join(dir, 'page.js'), `export default ${JSON.stringify(`page ${version}`)}\n`);
}

async function buildVersion(
  version: string,
  outDir: string,
  options: SkewProtectionOptions,
  overrides: AppOverrides = {},
) {
  const root = await mkdtemp(join(work, `src-${version}-`));
  await writeApp(root, version, overrides);
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: { ...overrides.build, outDir, emptyOutDir: true },
    plugins: [skewProtection(options)],
  });
  const manifest = JSON.parse(await readFile(join(outDir, 'skew-manifest.json'), 'utf8')) as SkewManifest;
  const assets = existsSync(join(outDir, 'assets')) ? (await readdir(join(outDir, 'assets'))).sort() : [];
  return { manifest, assets };
}

/** A host that serves the files of `directory`, like the live site of the previous deploy. */
function serveDirectory(directory: string): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname.replace('/app/', '');
    const file = join(directory, path);
    if (!existsSync(file)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(await readFile(file), { headers: { 'content-type': 'application/octet-stream' } });
  };
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'skew-test-'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('plugin build', () => {
  it('injects the recovery script and writes a manifest on the first deploy', async () => {
    const out = join(work, 'first');
    const { manifest, assets } = await buildVersion('v1', out, { previous: join(work, 'nothing-here') });
    expect(manifest.deploys).toHaveLength(1);
    expect(manifest.deploys[0]?.assets.map((a) => a.replace('assets/', '')).sort()).toEqual(assets);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    expect(html).toContain('vite:preloadError');
    expect(html.indexOf('vite:preloadError')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('carries old chunks forward and expires them by deploy count', async () => {
    const d1 = join(work, 'd1');
    const d2 = join(work, 'd2');
    const d3 = join(work, 'd3');
    const v1 = await buildVersion('v1', d1, { previous: false });
    const v2 = await buildVersion('v2', d2, { previous: d1 });
    const v3 = await buildVersion('v3', d3, { previous: d2, keep: { deploys: 1 } });

    const v1Page = v1.assets.find((a) => a.startsWith('page-'))!;
    const v2Page = v2.manifest.deploys[0]!.assets.find((a) => a.includes('/page-'))!;

    // v2 build contains v1's lazy chunk, so a tab opened on v1 keeps working.
    expect(v2.assets).toContain(v1Page);
    expect(v2.manifest.deploys).toHaveLength(2);
    expect(await readFile(join(d2, 'assets', v1Page), 'utf8')).toContain('page v1');

    // keep: 1 deploy -> v3 keeps v2's files but lets v1's go.
    expect(v3.assets).toContain(v2Page.replace('assets/', ''));
    expect(v3.assets).not.toContain(v1Page);
    expect(v3.manifest.deploys.map((d) => d.assets.length > 0)).toEqual([true, true]);
  });

  it('can disable recovery', async () => {
    const out = join(work, 'no-recover');
    await buildVersion('v1', out, { previous: false, recover: false });
    expect(await readFile(join(out, 'index.html'), 'utf8')).not.toContain('vite:preloadError');
  });

  it('treats an SPA fallback page as a missing file and drops it from the manifest', async () => {
    const d1 = join(work, 'r1');
    const v1 = await buildVersion('v1', d1, { previous: false });
    const manifestText = await readFile(join(d1, 'skew-manifest.json'), 'utf8');

    // A host that serves the manifest but answers every other path with index.html (status 200).
    const fakeFetch: typeof fetch = async (input) => {
      if (new URL(String(input)).pathname.endsWith('/skew-manifest.json')) {
        return new Response(manifestText, { headers: { 'content-type': 'application/json' } });
      }
      return new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } });
    };

    const d2 = join(work, 'r2');
    const v2 = await buildVersion('v2', d2, { previous: 'https://example.test/app', fetch: fakeFetch });
    const v1Page = v1.assets.find((a) => a.startsWith('page-'))!;
    expect(existsSync(join(d2, 'assets', v1Page))).toBe(false);
    expect(v2.manifest.deploys[1]?.assets).toEqual([]);
  });

  it('does not fail the build when the previous deploy is unreachable (unless strict)', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const out = join(work, 'unreachable');
    const ok = await buildVersion('v1', out, { previous: 'https://example.test', fetch: failing });
    expect(ok.manifest.deploys).toHaveLength(1);

    await expect(
      buildVersion('v1', join(work, 'strict'), { previous: 'https://example.test', fetch: failing, strict: true }),
    ).rejects.toThrow(/can't reach previous deploy/);
  });

  it('carries chunks that live outside build.assetsDir (custom chunkFileNames)', async () => {
    const output = { entryFileNames: 'js/[name]-[hash].js', chunkFileNames: 'js/[name]-[hash].js' };
    const d1 = join(work, 'c1');
    const d2 = join(work, 'c2');
    const v1 = await buildVersion('v1', d1, { previous: false }, { build: { rollupOptions: { output } } });
    const v2 = await buildVersion('v2', d2, { previous: d1 }, { build: { rollupOptions: { output } } });

    const v1Page = v1.manifest.deploys[0]!.assets.find((a) => a.startsWith('js/page-'))!;
    expect(v1Page).toBeDefined();
    expect(v2.manifest.deploys[0]?.assets).not.toContain(v1Page);
    expect(v2.manifest.deploys[1]?.assets).toContain(v1Page);
    expect(await readFile(join(d2, v1Page), 'utf8')).toContain('page v1');
  });

  it('records the assets of every output in one deploy (several outputs, plugin-legacy)', async () => {
    const outputs = [
      { format: 'es' as const, entryFileNames: 'modern/[name]-[hash].js', chunkFileNames: 'modern/[name]-[hash].js' },
      { format: 'es' as const, entryFileNames: 'legacy/[name]-[hash].js', chunkFileNames: 'legacy/[name]-[hash].js' },
    ];
    const d1 = join(work, 'm1');
    const d2 = join(work, 'm2');
    const v1 = await buildVersion('v1', d1, { previous: false }, { build: { rollupOptions: { output: outputs } } });
    const v2 = await buildVersion('v2', d2, { previous: d1 }, { build: { rollupOptions: { output: outputs } } });

    expect(v1.manifest.deploys).toHaveLength(1);
    const v1Assets = v1.manifest.deploys[0]!.assets;
    const v1Pages = v1Assets.filter((a) => a.includes('/page-'));
    expect(v1Pages.map((a) => a.split('/')[0])).toEqual(['legacy', 'modern']);

    // Both outputs belong to one deploy, and the old chunks of both are carried.
    expect(v2.manifest.deploys).toHaveLength(2);
    expect(v2.manifest.deploys[0]!.assets.some((a) => a.startsWith('legacy/'))).toBe(true);
    expect(v2.manifest.deploys[0]!.assets.some((a) => a.startsWith('modern/'))).toBe(true);
    for (const page of v1Pages) {
      expect(await readFile(join(d2, page), 'utf8')).toContain('page v1');
    }
  });

  it('never overwrites a file that is already in the new build', async () => {
    const d1 = join(work, 'o1');
    const v1 = await buildVersion('v1', d1, { previous: false });
    const v1Page = v1.manifest.deploys[0]!.assets.find((a) => a.includes('/page-'))!;

    // The previous deploy claims `robots.txt` as one of its assets, with other contents.
    const previousManifest: SkewManifest = {
      version: 1,
      deploys: [{ ...v1.manifest.deploys[0]!, assets: [v1Page, 'robots.txt'] }],
    };
    await writeFile(join(d1, 'skew-manifest.json'), JSON.stringify(previousManifest));
    await writeFile(join(d1, 'robots.txt'), 'old robots');

    const d2 = join(work, 'o2');
    await buildVersion('v2', d2, { previous: d1 }, { publicFiles: { 'robots.txt': 'new robots' } });

    expect(await readFile(join(d2, 'robots.txt'), 'utf8')).toBe('new robots');
    expect(await readFile(join(d2, v1Page), 'utf8')).toContain('page v1');
  });

  it('retries a failed download, so one network error does not lose the history', async () => {
    const d1 = join(work, 't1');
    const v1 = await buildVersion('v1', d1, { previous: false });
    const serve = serveDirectory(d1);

    const failedOnce = new Set<string>();
    const flakyFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (!failedOnce.has(url)) {
        failedOnce.add(url);
        if (new URL(url).pathname.endsWith('.json')) {
          throw new Error('ECONNRESET');
        }
        return new Response('bad gateway', { status: 502 });
      }
      return serve(input);
    };

    const d2 = join(work, 't2');
    const v2 = await buildVersion('v2', d2, { previous: 'https://example.test/app/', fetch: flakyFetch, strict: true });
    const v1Page = v1.assets.find((a) => a.startsWith('page-'))!;
    expect(v2.manifest.deploys).toHaveLength(2);
    expect(v2.assets).toContain(v1Page);
  });

  it('bypasses the CDN cache for the manifest, but not for the assets', async () => {
    const d1 = join(work, 'c1');
    await buildVersion('v1', d1, { previous: false });
    const serve = serveDirectory(d1);

    const requests: { url: URL; cacheControl: string | null }[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), cacheControl: new Headers(init?.headers).get('cache-control') });
      return serve(input);
    };

    await buildVersion('v2', join(work, 'c2'), {
      previous: 'https://example.test/app/',
      fetch: recordingFetch,
      headers: { authorization: 'Bearer token' },
    });

    const manifestRequests = requests.filter((r) => r.url.pathname.endsWith('/skew-manifest.json'));
    const assetRequests = requests.filter((r) => !r.url.pathname.endsWith('/skew-manifest.json'));
    expect(manifestRequests).toHaveLength(1);
    expect(manifestRequests[0]!.url.searchParams.get('skew')).toBeTruthy();
    expect(manifestRequests[0]!.cacheControl).toBe('no-cache');
    expect(assetRequests.length).toBeGreaterThan(0);
    for (const request of assetRequests) {
      expect(request.url.search).toBe('');
      expect(request.cacheControl).toBeNull();
    }
  });

  it('does not retry a missing file', async () => {
    let requests = 0;
    const notFound: typeof fetch = async () => {
      requests++;
      return new Response('not found', { status: 404 });
    };
    await buildVersion('v1', join(work, 'nf'), { previous: 'https://example.test/', fetch: notFound });
    expect(requests).toBe(1);
  });

  it('treats HTTP 403 for the manifest as the first deploy, even with strict (S3 without ListBucket)', async () => {
    let requests = 0;
    const forbidden: typeof fetch = async () => {
      requests++;
      return new Response('AccessDenied', { status: 403 });
    };
    const { manifest } = await buildVersion('v1', join(work, 's3'), {
      previous: 'https://bucket.example.test/',
      fetch: forbidden,
      strict: true,
    });
    expect(manifest.deploys).toHaveLength(1);
    expect(requests).toBe(1);
  });

  it('keeps <meta charset> in front of the recovery script', async () => {
    const out = join(work, 'charset');
    await buildVersion('v1', out, { previous: false }, { head: '<meta charset="utf-8" /><title>t</title>' });
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const charsetEnd = html.indexOf('charset="utf-8"') + 'charset="utf-8"'.length;

    expect(html).toContain('vite:preloadError');
    expect(charsetEnd).toBeLessThan(html.indexOf('vite:preloadError'));
    expect(Buffer.byteLength(html.slice(0, charsetEnd))).toBeLessThan(1024);
    expect(html.indexOf('vite:preloadError')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('ignores a <meta charset> inside a comment and prepends the script to <head>', async () => {
    const out = join(work, 'charset-comment');
    await buildVersion('v1', out, { previous: false }, { head: '<title>t</title><!-- <meta charset="utf-8"> -->' });
    const html = await readFile(join(out, 'index.html'), 'utf8');

    expect(html.indexOf('vite:preloadError')).toBeLessThan(html.indexOf('<title>'));
  });
});
