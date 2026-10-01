import type { ChunkInfo } from './chunk';

interface Deploy {
  id: string;
  time: number;
}

const POLL_INTERVAL_MS = 30_000;
/** The minute of the hourly cron in `.github/workflows/demo.yml`. */
const DEPLOY_MINUTE = 17;
const RECOVERED_FROM_KEY = 'skew-demo:recovered-from';

const deploysElement = document.getElementById('deploys')!;
const statusElement = document.getElementById('status')!;
const resultElement = document.getElementById('result')!;
const noticeElement = document.getElementById('notice')!;
const carriedButton = document.getElementById('load-carried') as HTMLButtonElement;
const notCarriedButton = document.getElementById('load-not-carried') as HTMLButtonElement;

document.getElementById('build')!.textContent = __BUILD_ID__;
document.getElementById('built-at')!.textContent = formatTime(__BUILD_TIME__);

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString();
}

function showResult(className: string, text: string): void {
  const line = document.createElement('span');
  line.className = className;
  line.textContent = text;
  resultElement.replaceChildren(line);
}

/** The manifest the plugin publishes with every deploy lists the recent deploys, newest first. */
async function readDeploys(): Promise<Deploy[]> {
  // The unique query gets past the CDN of GitHub Pages, which keeps files for 10 minutes.
  const response = await fetch(`skew-manifest.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const manifest = (await response.json()) as { deploys: Deploy[] };
  return manifest.deploys;
}

function nextScheduledDeploy(): Date {
  const next = new Date();
  if (next.getUTCMinutes() >= DEPLOY_MINUTE) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  next.setUTCMinutes(DEPLOY_MINUTE, 0, 0);
  return next;
}

async function checkForDeploys(): Promise<void> {
  let deploys: Deploy[];
  try {
    deploys = await readDeploys();
  } catch {
    // The site is briefly unavailable or the tab is offline: the next check will tell.
    return;
  }

  // The plugin adds a random suffix to the id it is given.
  const isOwnDeploy = (deploy: Deploy) => deploy.id.startsWith(`${__BUILD_ID__}-`);
  const newerDeploys = deploys.filter((deploy) => !isOwnDeploy(deploy) && deploy.time > __BUILD_TIME__);
  const latestDeploy = newerDeploys[0];

  if (!latestDeploy) {
    const next = nextScheduledDeploy().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    deploysElement.textContent = `No deploy since this tab was opened. The next one is scheduled for about ${next}, GitHub often starts it some minutes late.`;
    return;
  }

  const count = newerDeploys.length === 1 ? '1 new deploy' : `${newerDeploys.length} new deploys`;
  const isStillKept = deploys.some(isOwnDeploy);
  deploysElement.textContent = isStillKept
    ? `${count} since this tab was opened, the latest at ${formatTime(latestDeploy.time)}. Press the buttons.`
    : `${count} since this tab was opened. The files of this build have expired, so both buttons end with a reload.`;
  statusElement.dataset.state = 'ready';
  carriedButton.disabled = false;
  notCarriedButton.disabled = false;
}

async function loadChunk(load: () => Promise<{ info: ChunkInfo }>): Promise<void> {
  try {
    const { info } = await load();
    showResult(
      'ok',
      `✅ ${info.fileName} loaded. It belongs to build ${info.buildId}: the newest build doesn't produce this file, the plugin copied it from the previous deploy. No reload, this tab keeps working.`,
    );
  } catch (error) {
    const reloading = window.__SKEW_PROTECTION__?.reloading;
    showResult('error', `💥 ${(error as Error).message}${reloading ? ' Reloading…' : ''}`);
  }
}

carriedButton.addEventListener('click', () => loadChunk(() => import('./carried')));
notCarriedButton.addEventListener('click', () => loadChunk(() => import('./not-carried')));

// The recovery script announces the reload. Remember it to explain what happened on the page that loads next.
window.addEventListener('skew:reload', () => {
  sessionStorage.setItem(RECOVERED_FROM_KEY, __BUILD_ID__);
});

const recoveredFrom = sessionStorage.getItem(RECOVERED_FROM_KEY);
if (recoveredFrom) {
  sessionStorage.removeItem(RECOVERED_FROM_KEY);
  noticeElement.hidden = false;
  noticeElement.textContent =
    recoveredFrom === __BUILD_ID__
      ? `A chunk of build ${recoveredFrom} was gone (404), so the recovery script reloaded this tab. The CDN still answered with the old index.html: GitHub Pages caches it for up to 10 minutes. That is why the README asks for "Cache-Control: no-cache" on index.html.`
      : `A chunk of build ${recoveredFrom} was gone (404), so the recovery script reloaded this tab once. It now runs the newest build, ${__BUILD_ID__}.`;
}

void checkForDeploys();
setInterval(() => void checkForDeploys(), POLL_INTERVAL_MS);
