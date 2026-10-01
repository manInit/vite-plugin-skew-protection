import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type PluginOption } from 'vite';

const root = fileURLToPath(new URL('./fixtures/app', import.meta.url));

/**
 * Builds the demo app into a new directory inside `workDir` and returns its path.
 * The version is shown on the page and baked into every chunk, so each version gets new file hashes.
 */
export async function buildApp(workDir: string, version: string, plugins: PluginOption[] = []): Promise<string> {
  const outDir = await mkdtemp(join(workDir, `dist-${version}-`));
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { outDir, emptyOutDir: true },
    plugins,
  });
  return outDir;
}
