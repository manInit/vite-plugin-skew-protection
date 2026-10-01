/**
 * Turns a browser script from `src` into a minified ES5 string at build time:
 *
 *   import code from './runtime/recovery.ts?inline-script';
 *
 * Used by tsup (esbuild plugin) and by Vitest (Vite plugin), so tests run the same code as the package.
 */
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { transform, type Plugin as EsbuildPlugin } from 'esbuild';
import type { Plugin as VitePlugin } from 'vite';

const SUFFIX = '?inline-script';
const NAMESPACE = 'inline-script';

async function compileInlineScript(filePath: string): Promise<string> {
  const source = await readFile(filePath, 'utf8');
  const result = await transform(source, {
    loader: 'ts',
    // Wraps the script in a function, so its variables don't leak into `window`.
    format: 'iife',
    // Fails the build on syntax that old browsers can't parse (`let`, destructuring, ...).
    target: 'es5',
    minify: true,
    sourcefile: filePath,
  });
  return result.code.trim();
}

export function inlineScriptEsbuildPlugin(): EsbuildPlugin {
  return {
    name: 'inline-script',
    setup(build) {
      // esbuild prints the module path in a comment of the bundle, so it is kept relative to the project:
      // an absolute one would publish the directory layout of the build machine.
      const projectRoot = build.initialOptions.absWorkingDir ?? process.cwd();
      build.onResolve({ filter: /\?inline-script$/ }, (args) => ({
        path: relative(projectRoot, resolve(args.resolveDir, args.path.slice(0, -SUFFIX.length)))
          .split(sep)
          .join('/'),
        namespace: NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
        const filePath = resolve(projectRoot, args.path);
        return {
          contents: await compileInlineScript(filePath),
          loader: 'text',
          resolveDir: dirname(filePath),
          watchFiles: [filePath],
        };
      });
    },
  };
}

export function inlineScriptVitePlugin(): VitePlugin {
  return {
    name: 'inline-script',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith(SUFFIX)) {
        return null;
      }
      const code = await compileInlineScript(id.slice(0, -SUFFIX.length));
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
