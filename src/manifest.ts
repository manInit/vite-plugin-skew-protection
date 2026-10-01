/**
 * The skew manifest is published next to the build output as `skew-manifest.json`.
 * It records which assets every recent deploy shipped, so the next build knows
 * which old files open tabs may still request and must be copied forward.
 *
 * This file has no side effects, so it can be unit-tested without Vite.
 */

import { isObject } from './utils';

export const MANIFEST_VERSION = 1;

const MILLISECONDS_IN_DAY = 24 * 60 * 60 * 1000;
const MAX_ASSET_PATH_LENGTH = 1024;

export interface DeployEntry {
  /** Unique id of the build (git commit, CI run id or a random id). */
  id: string;
  /** Build time in milliseconds since epoch. */
  time: number;
  /** Asset paths relative to the output directory, e.g. `assets/page-B1a2c3.js`. */
  assets: string[];
}

export interface SkewManifest {
  version: typeof MANIFEST_VERSION;
  /** Newest first. The first entry is the deploy that published this manifest. */
  deploys: DeployEntry[];
}

export interface KeepPolicy {
  /** How many previous deploys to keep assets for. */
  deploys: number;
  /** Drop assets of deploys older than this many days. */
  days: number;
}

export interface DeployPlan {
  /** Manifest to publish with the new build. The new deploy comes first. */
  manifest: SkewManifest;
  /** Old asset paths that the new build doesn't have and must be copied into it. */
  oldAssetsToCopy: string[];
  /** Previous deploys whose assets are no longer kept. */
  expiredDeploys: DeployEntry[];
}

export function isHtmlFile(path: string): boolean {
  const lowerCasePath = path.toLowerCase();
  return lowerCasePath.endsWith('.html') || lowerCasePath.endsWith('.htm');
}

/**
 * Asset paths come from a file on the previous deploy and decide where we write
 * downloaded files, so a path must never point outside the output directory.
 */
export function isSafeAssetPath(path: unknown): path is string {
  if (typeof path !== 'string') {
    return false;
  }
  if (path.length === 0 || path.length > MAX_ASSET_PATH_LENGTH) {
    return false;
  }

  const isAbsolute = path.startsWith('/');
  const hasForbiddenCharacter = path.includes('\\') || path.includes(':') || path.includes('\0');
  if (isAbsolute || hasForbiddenCharacter) {
    return false;
  }

  const segments = path.split('/');
  const hasEmptyOrRelativeSegment = segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (hasEmptyOrRelativeSegment) {
    return false;
  }

  // HTML pages are never versioned assets, and we must not overwrite the new index.html.
  if (isHtmlFile(path)) {
    return false;
  }

  return true;
}

/**
 * Checks JSON downloaded from the previous deploy.
 * Returns null when it isn't a skew manifest. Invalid deploys and unsafe paths are skipped.
 */
export function parseManifest(json: unknown): SkewManifest | null {
  if (!isObject(json)) {
    return null;
  }
  if (json.version !== MANIFEST_VERSION) {
    return null;
  }
  if (!Array.isArray(json.deploys)) {
    return null;
  }

  const deploys: DeployEntry[] = [];
  for (const value of json.deploys) {
    const deploy = parseDeployEntry(value);
    if (deploy) {
      deploys.push(deploy);
    }
  }

  const newestFirst = deploys.sort((first, second) => second.time - first.time);
  return { version: MANIFEST_VERSION, deploys: newestFirst };
}

function parseDeployEntry(value: unknown): DeployEntry | null {
  if (!isObject(value)) {
    return null;
  }

  const { id, time, assets } = value;
  if (typeof id !== 'string') {
    return null;
  }
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    return null;
  }
  if (!Array.isArray(assets)) {
    return null;
  }

  const safeAssets = assets.filter(isSafeAssetPath);
  const uniqueAssets = [...new Set(safeAssets)];
  return { id, time, assets: uniqueAssets };
}

/**
 * Decides which previous deploys stay available and which old files the new build must include.
 */
export function planDeploy(
  previousManifest: SkewManifest | null,
  currentDeploy: DeployEntry,
  keep: KeepPolicy,
  now: number = Date.now(),
): DeployPlan {
  const previousDeploys = previousManifest?.deploys ?? [];
  const keptDeploys: DeployEntry[] = [];
  const expiredDeploys: DeployEntry[] = [];

  for (const deploy of previousDeploys) {
    // The same build can run twice (for example a CI re-run). Its old entry is replaced by the new one.
    if (deploy.id === currentDeploy.id) {
      continue;
    }

    const ageInMilliseconds = now - deploy.time;
    const isRecentEnough = ageInMilliseconds < keep.days * MILLISECONDS_IN_DAY;
    const hasRoomLeft = keptDeploys.length < keep.deploys;

    if (isRecentEnough && hasRoomLeft) {
      keptDeploys.push(deploy);
    } else {
      expiredDeploys.push(deploy);
    }
  }

  const currentAssets = new Set(currentDeploy.assets);
  const oldAssetsToCopy = new Set<string>();
  for (const deploy of keptDeploys) {
    for (const asset of deploy.assets) {
      if (!currentAssets.has(asset)) {
        oldAssetsToCopy.add(asset);
      }
    }
  }

  return {
    manifest: { version: MANIFEST_VERSION, deploys: [currentDeploy, ...keptDeploys] },
    oldAssetsToCopy: [...oldAssetsToCopy].sort(),
    expiredDeploys,
  };
}

/**
 * Removes files that could not be copied from the previous deploys,
 * so the manifest never lists files that aren't in the build.
 * The first deploy is the current build, and its files are always there.
 */
export function removeMissingAssets(manifest: SkewManifest, missingAssets: Set<string>): SkewManifest {
  const [currentDeploy, ...previousDeploys] = manifest.deploys;
  if (!currentDeploy || missingAssets.size === 0) {
    return manifest;
  }

  const cleanedPreviousDeploys = previousDeploys.map((deploy) => ({
    ...deploy,
    assets: deploy.assets.filter((asset) => !missingAssets.has(asset)),
  }));

  return { ...manifest, deploys: [currentDeploy, ...cleanedPreviousDeploys] };
}
