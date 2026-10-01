import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger, Plugin, ResolvedConfig } from 'vite';
import {
  MANIFEST_VERSION,
  isHtmlFile,
  parseManifest,
  planDeploy,
  removeMissingAssets,
  type DeployEntry,
  type DeployPlan,
  type SkewManifest,
} from './manifest';
import { resolveOptions, type SkewProtectionOptions } from './options';
import { HttpStatusError, openPreviousDeploy, type PreviousDeploy } from './source';
import { createRecoveryScript } from './runtime';
import { formatSize, parseJson, runWithConcurrency } from './utils';

const LOG_PREFIX = '[skew-protection]';

/** What the plugin remembers between the `writeBundle` calls of one build. */
interface BuildState {
  id: string;
  time: number;
  /** Loaded once per build, by the first output. */
  previous?: Promise<{ deploy: PreviousDeploy | null; manifest: SkewManifest | null }>;
  /** A build can have several outputs (for example `@vitejs/plugin-legacy` adds one), usually in the same directory. */
  outputs: Map<string, OutputState>;
}

interface OutputState {
  /** Versioned assets of every output written into this directory so far. */
  assets: Set<string>;
  /** Old assets that are already in the directory, so a later output doesn't fetch them again. */
  copiedAssets: Set<string>;
  copyResult: CopyResult;
}

export default function skewProtection(userOptions: SkewProtectionOptions = {}): Plugin {
  const options = resolveOptions(userOptions);
  const { manifestFileName, keep, recover } = options;

  let config: ResolvedConfig;
  let build: BuildState | undefined;

  function startBuild(): BuildState {
    return { id: getBuildId(options.buildId), time: Date.now(), outputs: new Map() };
  }

  async function loadPrevious(
    logger: Logger,
  ): Promise<{ deploy: PreviousDeploy | null; manifest: SkewManifest | null }> {
    const { previous } = options;
    if (!previous) {
      logger.info(`${LOG_PREFIX} \`previous\` is not set, old chunks won't be carried (recovery only)`);
      return { deploy: null, manifest: null };
    }
    if (keep.deploys <= 0) {
      return { deploy: null, manifest: null };
    }

    const deploy = openPreviousDeploy(previous, {
      projectRoot: config.root,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
    });
    const manifest = await readPreviousManifest(deploy, manifestFileName, options.strict, logger);
    return { deploy, manifest };
  }

  return {
    name: 'vite-plugin-skew-protection',
    apply: 'build',

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!recover) {
          return;
        }
        const script = createRecoveryScript(recover.cooldownMs);
        const position = findPositionAfterCharsetMeta(html);
        if (position === -1) {
          return [{ tag: 'script', children: script, injectTo: 'head-prepend' }];
        }
        return `${html.slice(0, position)}<script>${script}</script>${html.slice(position)}`;
      },
    },

    writeBundle: {
      sequential: true,
      order: 'post',
      async handler(outputOptions, bundle) {
        if (!isClientBuild(this, config)) {
          return;
        }

        const logger = config.logger;
        const outputDirectory = resolve(getOutputDirectory(outputOptions, config));
        const manifestPath = resolve(outputDirectory, manifestFileName);

        // One id and one time for the whole build, however many outputs it has.
        build ??= startBuild();
        let output = build.outputs.get(outputDirectory);
        if (!output) {
          output = {
            assets: new Set(),
            copiedAssets: new Set(),
            copyResult: { missingAssets: new Set(), copiedBytes: 0 },
          };
          build.outputs.set(outputDirectory, output);
        }

        // `writeBundle` runs once per output. Every call adds its files to the same deploy
        // and writes the manifest again, so the last call leaves the complete one.
        for (const asset of getVersionedAssets(Object.keys(bundle), manifestFileName, options.include)) {
          output.assets.add(asset);
        }
        if (output.assets.size === 0) {
          logger.warn(
            `${LOG_PREFIX} no files to protect: ${options.include ? '`include` matched none of the emitted files' : 'the build emitted no assets'}`,
          );
        }

        const currentDeploy: DeployEntry = { id: build.id, time: build.time, assets: [...output.assets].sort() };

        build.previous ??= loadPrevious(logger);
        const previous = await build.previous;

        const plan = planDeploy(previous.manifest, currentDeploy, keep);

        const { copyResult, copiedAssets } = output;
        if (previous.deploy) {
          const assetsToCopy = plan.oldAssetsToCopy.filter(
            (asset) => !copiedAssets.has(asset) && !copyResult.missingAssets.has(asset),
          );
          const newCopyResult = await copyOldAssets(
            assetsToCopy,
            previous.deploy,
            outputDirectory,
            options.concurrency,
            logger,
          );
          for (const asset of assetsToCopy) {
            if (newCopyResult.missingAssets.has(asset)) {
              copyResult.missingAssets.add(asset);
            } else {
              copiedAssets.add(asset);
            }
          }
          copyResult.copiedBytes += newCopyResult.copiedBytes;
        }

        const manifest = removeMissingAssets(plan.manifest, copyResult.missingAssets);
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

        logSummary(logger, plan, manifest, copyResult);
        logger.info(`${LOG_PREFIX} wrote ${relative(config.root, manifestPath)} (build ${currentDeploy.id})`);
      },
    },

    closeBundle() {
      // Runs once after the last output. `buildStart` can't be used to start a new build:
      // Vite 8 calls it for every output. In watch mode the next rebuild is a new deploy.
      build = undefined;
    },
  };
}

/**
 * `<meta charset>` only works within the first 1024 bytes of the page, so the script must not push it down.
 * Returns the position right after that tag, or -1 when the page has none (or we are not sure it is a real tag).
 */
function findPositionAfterCharsetMeta(html: string): number {
  const match = /<meta\s[^>]*charset\s*=[^>]*>/i.exec(html);
  if (!match) {
    return -1;
  }

  const textBefore = html.slice(0, match.index);
  const isInsideComment = textBefore.lastIndexOf('<!--') > textBefore.lastIndexOf('-->');
  const isAfterHead = /<\/head\s*>|<body[\s>]/i.test(textBefore);
  if (isInsideComment || isAfterHead) {
    return -1;
  }
  return match.index + match[0].length;
}

/**
 * Vite 6+ builds several environments (client, ssr, ...) and tells us which one this is.
 * Older Vite versions only have the `build.ssr` flag.
 */
function isClientBuild(pluginContext: unknown, config: ResolvedConfig): boolean {
  const environment = (pluginContext as { environment?: { config?: { consumer?: string } } }).environment;
  const consumer = environment?.config?.consumer;
  if (consumer) {
    return consumer === 'client';
  }
  return !config.build.ssr;
}

function getOutputDirectory(outputOptions: { dir?: string; file?: string }, config: ResolvedConfig): string {
  if (outputOptions.dir) {
    return outputOptions.dir;
  }
  if (outputOptions.file) {
    return dirname(outputOptions.file);
  }
  return config.build.outDir;
}

/**
 * Returns the emitted files worth carrying to later deploys: by default all of them.
 * Files without a hash in the name do no harm, a file the new build also has is never copied.
 */
function getVersionedAssets(
  fileNames: string[],
  manifestFileName: string,
  include: ((fileName: string) => boolean) | undefined,
): string[] {
  const isVersionedAsset = include ?? (() => true);

  return fileNames.filter((fileName) => shouldCarryFile(fileName, manifestFileName, isVersionedAsset));
}

/** HTML, the skew manifest and Vite's own `.vite/` files are never carried, whatever `include` says. */
function shouldCarryFile(
  fileName: string,
  manifestFileName: string,
  isVersionedAsset: (fileName: string) => boolean,
): boolean {
  return (
    !isHtmlFile(fileName) &&
    fileName !== manifestFileName &&
    !fileName.startsWith('.vite/') &&
    isVersionedAsset(fileName)
  );
}

/**
 * Downloads the manifest of the previous deploy.
 * Returns null on the first protected deploy (no manifest, or HTTP 403 for it), and also when the previous deploy can't be reached
 * (unless `strict` is set, then the build fails).
 */
async function readPreviousManifest(
  previousDeploy: PreviousDeploy,
  manifestFileName: string,
  strict: boolean,
  logger: Logger,
): Promise<SkewManifest | null> {
  let fileContents: Uint8Array | null;
  try {
    fileContents = await previousDeploy.readFile(manifestFileName);
  } catch (error) {
    // S3 and similar object storage answer 403 instead of 404 when the file doesn't exist
    // and the bucket can't be listed, which is how public buckets are usually set up.
    if (error instanceof HttpStatusError && error.status === 403) {
      logger.warn(
        `${LOG_PREFIX} ${manifestFileName} at ${previousDeploy.location} returned HTTP 403, treating it as the first protected deploy. ` +
          `If the site needs authorization, pass it in \`headers\``,
      );
      return null;
    }

    const message = `${LOG_PREFIX} can't reach previous deploy at ${previousDeploy.location}: ${(error as Error).message}`;
    if (strict) {
      throw new Error(message, { cause: error });
    }
    logger.warn(message);
    logger.warn(`${LOG_PREFIX} building without old chunks; open tabs may break after this deploy`);
    return null;
  }

  if (!fileContents) {
    logger.info(
      `${LOG_PREFIX} no ${manifestFileName} at ${previousDeploy.location}, looks like the first protected deploy`,
    );
    return null;
  }

  const manifest = parseManifest(parseJson(fileContents));
  if (!manifest) {
    logger.warn(`${LOG_PREFIX} ${manifestFileName} at ${previousDeploy.location} is not a skew manifest, ignoring it`);
  }
  return manifest;
}

interface CopyResult {
  /** Files that no longer exist on the previous deploy or failed to download. */
  missingAssets: Set<string>;
  copiedBytes: number;
}

/** Copies old assets from the previous deploy into the new output directory. */
async function copyOldAssets(
  assets: string[],
  previousDeploy: PreviousDeploy,
  outputDirectory: string,
  concurrency: number,
  logger: Logger,
): Promise<CopyResult> {
  const result: CopyResult = { missingAssets: new Set(), copiedBytes: 0 };

  await runWithConcurrency(assets, concurrency, async (asset) => {
    const targetPath = resolve(outputDirectory, asset);

    // The manifest already rejects unsafe paths. This is a second check right before writing.
    const isInsideOutputDirectory = targetPath.startsWith(outputDirectory + sep);
    if (!isInsideOutputDirectory) {
      result.missingAssets.add(asset);
      return;
    }

    let fileContents: Uint8Array | null = null;
    try {
      fileContents = await previousDeploy.readFile(asset);
    } catch (error) {
      logger.warn(`${LOG_PREFIX} failed to fetch ${asset}: ${(error as Error).message}`);
    }

    if (!fileContents) {
      result.missingAssets.add(asset);
      return;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    try {
      // `wx` never overwrites: a file of the new build or of `public/` wins over the one from the old manifest.
      await writeFile(targetPath, fileContents, { flag: 'wx' });
    } catch (error) {
      const fileAlreadyExists = (error as NodeJS.ErrnoException).code === 'EEXIST';
      if (fileAlreadyExists) {
        return;
      }
      throw error;
    }
    result.copiedBytes += fileContents.byteLength;
  });

  return result;
}

function logSummary(logger: Logger, plan: DeployPlan, manifest: SkewManifest, copyResult: CopyResult): void {
  const missingCount = copyResult.missingAssets.size;
  const copiedCount = plan.oldAssetsToCopy.length - missingCount;
  const previousDeployCount = manifest.deploys.length - 1;

  if (copiedCount > 0 || previousDeployCount > 0) {
    const size = formatSize(copyResult.copiedBytes);
    let message = `${LOG_PREFIX} kept ${copiedCount} old file(s), ${size}, from ${previousDeployCount} previous deploy(s)`;
    if (missingCount > 0) {
      message += `; ${missingCount} file(s) were already gone`;
    }
    logger.info(message);
  }

  if (plan.expiredDeploys.length > 0) {
    logger.info(`${LOG_PREFIX} expired ${plan.expiredDeploys.length} old deploy(s)`);
  }
}

/**
 * Takes the id from the options or from CI environment variables, and adds a random suffix:
 * the same commit can be built twice (CI re-runs), and every build needs its own id.
 */
function getBuildId(buildIdFromOptions: string | undefined): string {
  const environment = process.env;
  const commitId =
    buildIdFromOptions ??
    environment.SKEW_BUILD_ID ??
    environment.GITHUB_SHA ??
    environment.VERCEL_GIT_COMMIT_SHA ??
    environment.CF_PAGES_COMMIT_SHA ??
    environment.COMMIT_REF;

  const randomSuffix = randomBytes(3).toString('hex');
  if (commitId) {
    return `${commitId.slice(0, 12)}-${randomSuffix}`;
  }
  return `${Date.now().toString(36)}-${randomSuffix}`;
}

export { MANIFEST_VERSION, parseManifest, planDeploy };
export type { DeployEntry, SkewManifest };
export type { RecoverOptions, SkewProtectionOptions } from './options';
