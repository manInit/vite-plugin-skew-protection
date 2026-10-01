// End-to-end: a real browser against a static host that deletes old files on every deploy.
// A tab is opened on v1, then v2 is deployed, then the tab lazy-loads a chunk.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { PluginOption } from 'vite';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import skewProtection from '../../src/index';
import { buildApp } from './app';
import { startHost, type StaticHost } from './host';

/** Chromium and Firefox say "...dynamically imported module", Safari says "Importing a module script failed". */
const CHUNK_LOAD_ERROR = /dynamically imported module|Importing a module script failed/i;

let work: string;
let browser: Browser;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'skew-e2e-'));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await rm(work, { recursive: true, force: true });
});

async function newHost(): Promise<StaticHost> {
  const host = await startHost(work);
  onTestFinished(() => host.close());
  return host;
}

async function newPage(): Promise<Page> {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  return page;
}

/** Deploys v1, opens it in a tab, then deploys v2. Returns the tab, which is now one deploy behind. */
async function openStaleTab(plugins: (previous: string) => PluginOption[]): Promise<Page> {
  const host = await newHost();
  await host.deploy(await buildApp(work, 'v1', plugins(host.url)));
  const page = await newPage();
  await page.goto(host.url);
  await host.deploy(await buildApp(work, 'v2', plugins(host.url)));
  return page;
}

const viewText = (page: Page) => page.textContent('#view');
const versionText = (page: Page) => page.textContent('#version');

describe('a tab opened before a deploy', () => {
  it('breaks without the plugin', async () => {
    const page = await openStaleTab(() => []);

    await page.click('#open');

    await expect.poll(() => viewText(page)).toMatch(CHUNK_LOAD_ERROR);
  });

  it('keeps working without a reload when old chunks are carried forward', async () => {
    const page = await openStaleTab((previous) => [skewProtection({ previous })]);

    await page.click('#open');

    await expect.poll(() => viewText(page)).toContain('chunk from v1');
    expect(await versionText(page)).toBe('v1');
  });

  it('reloads into the new version when old chunks are gone', async () => {
    const page = await openStaleTab(() => [skewProtection({ previous: false })]);

    await page.click('#open');
    await expect.poll(() => versionText(page)).toBe('v2');
    await page.click('#open');

    await expect.poll(() => viewText(page)).toContain('chunk from v2');
  });
});

describe('when the page should not reload', () => {
  it('tells the app every time while the app keeps cancelling the reload', async () => {
    const page = await openStaleTab(() => [skewProtection({ previous: false })]);
    await page.evaluate(() => {
      window.addEventListener('skew:reload', (event) => {
        event.preventDefault();
        document.body.dataset.cancelled = String(Number(document.body.dataset.cancelled ?? 0) + 1);
      });
    });
    const cancelledCount = () => page.evaluate(() => document.body.dataset.cancelled);

    await page.click('#open');
    await expect.poll(cancelledCount).toBe('1');
    await page.click('#open');
    await expect.poll(cancelledCount).toBe('2');

    expect(await versionText(page)).toBe('v1');
  });

  it('does not reload while the browser is offline', async () => {
    const page = await openStaleTab(() => [skewProtection({ previous: false })]);
    let loads = 0;
    page.on('load', () => loads++);
    await page.context().setOffline(true);

    await page.click('#open');

    await expect.poll(() => viewText(page)).toMatch(CHUNK_LOAD_ERROR);
    expect(await page.evaluate(() => window.__SKEW_PROTECTION__?.reloading)).toBe(false);
    expect(await versionText(page)).toBe('v1');
    expect(loads).toBe(0);
  });
});

describe('a deploy that is really broken', () => {
  it('reloads once, then lets the error surface instead of looping', async () => {
    const dist = await buildApp(work, 'v1', [skewProtection({ previous: false })]);
    for (const file of await readdir(join(dist, 'assets'))) {
      if (file.startsWith('settings-')) {
        await rm(join(dist, 'assets', file));
      }
    }
    const host = await newHost();
    await host.deploy(dist);
    const page = await newPage();
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto(host.url);

    const reloaded = page.waitForEvent('load');
    await page.click('#open');
    await reloaded;
    await page.click('#open');

    await expect.poll(() => viewText(page)).toMatch(CHUNK_LOAD_ERROR);
    expect(await page.evaluate(() => window.__SKEW_PROTECTION__?.reloading)).toBe(false);
    expect(loads).toBe(2);
  });
});
