// Installs the packed plugin next to a given Vite version and runs two builds in a row:
// the second one must carry the lazy chunk of the first. Used by CI for the Vite versions
// the package claims to support but doesn't develop against.
//
//   pnpm build && node test/compat/run.mjs 5

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const viteVersion = process.argv[2];
if (!viteVersion) {
  throw new Error('Usage: node test/compat/run.mjs <vite version>');
}

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'skew-compat-'));

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

async function buildVersion(version, previous) {
  await writeFile(join(work, 'page.js'), `export default ${JSON.stringify(`page ${version}`)};\n`);
  run('npx', ['vite', 'build', '--outDir', `dist-${version}`], work);
  const manifest = JSON.parse(await readFile(join(work, `dist-${version}`, 'skew-manifest.json'), 'utf8'));
  if (manifest.deploys.length !== (previous ? 2 : 1)) {
    throw new Error(`${version}: unexpected manifest ${JSON.stringify(manifest)}`);
  }
  return manifest;
}

try {
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', work], packageRoot);
  await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'skew-compat', private: true, type: 'module' }));
  await writeFile(
    join(work, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8" /></head><body><script type="module" src="./main.js"></script></body></html>',
  );
  await writeFile(join(work, 'main.js'), `window.load = () => import('./page.js');\n`);
  await writeFile(
    join(work, 'vite.config.js'),
    [
      `import { defineConfig } from 'vite';`,
      `import skewProtection from 'vite-plugin-skew-protection';`,
      `export default defineConfig({ plugins: [skewProtection({ previous: process.env.PREVIOUS || false })] });`,
      '',
    ].join('\n'),
  );

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const tarball = join(work, `${packageJson.name}-${packageJson.version}.tgz`);
  run('npm', ['install', '--no-audit', '--no-fund', `vite@${viteVersion}`, tarball], work);

  const first = await buildVersion('v1', false);
  const oldPage = first.deploys[0].assets.find((asset) => asset.includes('page-'));
  if (!oldPage) {
    throw new Error(`v1: no lazy chunk in ${JSON.stringify(first)}`);
  }

  process.env.PREVIOUS = './dist-v1';
  const second = await buildVersion('v2', true);
  if (second.deploys[0].assets.includes(oldPage) || !existsSync(join(work, 'dist-v2', oldPage))) {
    throw new Error(`v2: ${oldPage} was not carried forward`);
  }
  if (!(await readFile(join(work, 'dist-v2', 'index.html'), 'utf8')).includes('vite:preloadError')) {
    throw new Error('v2: no recovery script in index.html');
  }

  const installedVite = JSON.parse(await readFile(join(work, 'node_modules/vite/package.json'), 'utf8')).version;
  console.log(`\nOK: vite ${installedVite}, ${oldPage} carried from v1 to v2`);
} finally {
  await rm(work, { recursive: true, force: true });
}
