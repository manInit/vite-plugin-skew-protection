import { describe, expect, it } from 'vitest';
import { isSafeAssetPath, parseManifest, planDeploy, removeMissingAssets, type DeployEntry } from '../../src/manifest';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30);
const deploy = (id: string, daysAgo: number, assets: string[]): DeployEntry => ({
  id,
  time: NOW - daysAgo * DAY,
  assets,
});

describe('isSafeAssetPath', () => {
  it('accepts normal asset paths', () => {
    expect(isSafeAssetPath('assets/index-B1a2c3.js')).toBe(true);
    expect(isSafeAssetPath('assets/nested/font-x.woff2')).toBe(true);
  });

  it.each([
    '../secret',
    'assets/../../x.js',
    '/etc/passwd',
    'C:\\x.js',
    'assets\\x.js',
    'assets//x.js',
    'index.html',
    '',
    './a.js',
  ])('rejects %j', (p) => expect(isSafeAssetPath(p)).toBe(false));
});

describe('parseManifest', () => {
  it('rejects non-manifests (e.g. an SPA fallback page parsed as JSON)', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({})).toBeNull();
    expect(parseManifest({ version: 2, deploys: [] })).toBeNull();
  });

  it('drops invalid entries and unsafe paths, sorts newest first', () => {
    const m = parseManifest({
      version: 1,
      deploys: [
        { id: 'old', time: 1, assets: ['assets/a.js'] },
        { id: 'bad', time: 'x', assets: [] },
        { id: 'new', time: 2, assets: ['assets/b.js', '../../evil.js', 'assets/b.js'] },
      ],
    });
    expect(m?.deploys.map((d) => d.id)).toEqual(['new', 'old']);
    expect(m?.deploys[0]?.assets).toEqual(['assets/b.js']);
  });
});

describe('planDeploy', () => {
  const current = deploy('v4', 0, ['assets/index-4.js', 'assets/shared.js']);

  it('first deploy carries nothing', () => {
    const plan = planDeploy(null, current, { deploys: 5, days: 7 }, NOW);
    expect(plan.oldAssetsToCopy).toEqual([]);
    expect(plan.manifest.deploys).toEqual([current]);
  });

  it('carries assets of previous deploys that the new build lacks', () => {
    const prev = {
      version: 1 as const,
      deploys: [
        deploy('v3', 1, ['assets/index-3.js', 'assets/shared.js']),
        deploy('v2', 2, ['assets/index-2.js', 'assets/lazy-2.js']),
      ],
    };
    const plan = planDeploy(prev, current, { deploys: 5, days: 7 }, NOW);
    expect(plan.oldAssetsToCopy).toEqual(['assets/index-2.js', 'assets/index-3.js', 'assets/lazy-2.js']);
    expect(plan.manifest.deploys.map((d) => d.id)).toEqual(['v4', 'v3', 'v2']);
  });

  it('expires deploys by count and by age', () => {
    const prev = {
      version: 1 as const,
      deploys: [deploy('v3', 1, ['assets/3.js']), deploy('v2', 2, ['assets/2.js']), deploy('v1', 30, ['assets/1.js'])],
    };
    const byCount = planDeploy(prev, current, { deploys: 1, days: 365 }, NOW);
    expect(byCount.oldAssetsToCopy).toEqual(['assets/3.js']);
    expect(byCount.expiredDeploys.map((d) => d.id)).toEqual(['v2', 'v1']);

    const byAge = planDeploy(prev, current, { deploys: 10, days: 7 }, NOW);
    expect(byAge.oldAssetsToCopy).toEqual(['assets/2.js', 'assets/3.js']);
    expect(byAge.expiredDeploys.map((d) => d.id)).toEqual(['v1']);
  });

  it('ignores a previous entry with the same id (rebuilding the same deploy)', () => {
    const prev = { version: 1 as const, deploys: [deploy('v4', 0, ['assets/stale.js'])] };
    expect(planDeploy(prev, current, { deploys: 5, days: 7 }, NOW).oldAssetsToCopy).toEqual([]);
  });
});

describe('removeMissingAssets', () => {
  it('removes missing files from previous deploys only', () => {
    const m = {
      version: 1 as const,
      deploys: [deploy('v2', 0, ['assets/x.js']), deploy('v1', 1, ['assets/x.js', 'assets/y.js'])],
    };
    const out = removeMissingAssets(m, new Set(['assets/x.js']));
    expect(out.deploys[0]?.assets).toEqual(['assets/x.js']);
    expect(out.deploys[1]?.assets).toEqual(['assets/y.js']);
  });
});
