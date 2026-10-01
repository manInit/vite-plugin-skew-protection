import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

export interface StaticHost {
  url: string;
  /** Replaces everything on the site with the files from `dist`, like most static hosts do. */
  deploy(dist: string): Promise<void>;
  close(): Promise<void>;
}

/** A static host with the usual caching: HTML and JSON are revalidated, hashed assets are immutable. */
export async function startHost(workDir: string): Promise<StaticHost> {
  const siteDir = await mkdtemp(join(workDir, 'site-'));

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://host').pathname);
    const file = join(siteDir, path.endsWith('/') ? `${path}index.html` : path);
    const isFile = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!isFile) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = extname(file);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' || ext === '.json' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(await readFile(file));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    async deploy(dist) {
      for (const entry of await readdir(siteDir)) {
        await rm(join(siteDir, entry), { recursive: true, force: true });
      }
      await cp(dist, siteDir, { recursive: true });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
