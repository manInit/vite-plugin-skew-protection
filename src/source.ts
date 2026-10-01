import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isHtmlFile } from './manifest';
import { isUrl, sleep } from './utils';

/**
 * The place where the previous deploy lives: either the live site (a URL)
 * or a directory on disk (a CI cache or a copy of the previous dist).
 */
export interface PreviousDeploy {
  /** Human-readable location, used in log messages. */
  location: string;
  /** Returns the file contents, or null when the file does not exist. Throws on any other error. */
  readFile(path: string): Promise<Uint8Array | null>;
}

export interface PreviousDeployOptions {
  /** Directory that relative paths are resolved against. */
  projectRoot: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export function openPreviousDeploy(previous: string, options: PreviousDeployOptions): PreviousDeploy {
  if (isUrl(previous)) {
    return openRemoteDeploy(previous, options);
  }

  const directory = resolve(options.projectRoot, previous);
  return openLocalDeploy(directory);
}

/** How many times a request is made before giving up, and the pause before the second one (it grows with every attempt). */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

/** The host answered, but not with the file. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(url: string, status: number) {
    super(`GET ${url} returned HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function openRemoteDeploy(siteUrl: string, options: PreviousDeployOptions): PreviousDeploy {
  // Without a trailing slash `new URL('assets/a.js', base)` would replace the last path segment.
  const baseUrl = new URL(siteUrl.endsWith('/') ? siteUrl : siteUrl + '/');
  const fetchFile = options.fetch ?? globalThis.fetch;

  async function requestFile(path: string): Promise<Uint8Array | null> {
    const fileUrl = new URL(path, baseUrl);
    const response = await fetchFile(fileUrl, {
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'follow',
    });

    if (response.status === 404 || response.status === 410) {
      return null;
    }
    if (!response.ok) {
      throw new HttpStatusError(fileUrl.href, response.status);
    }

    // Single-page app hosts often answer unknown paths with index.html and status 200.
    // That is not the file we asked for, so we treat it as missing.
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html') && !isHtmlFile(path)) {
      return null;
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    location: baseUrl.href,

    async readFile(path) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await requestFile(path);
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS || !isWorthRetrying(error)) {
            throw error;
          }
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    },
  };
}

/** Network errors, timeouts and 5xx often go away on the next attempt. Other statuses (401, 403, ...) don't. */
function isWorthRetrying(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status >= 500;
  }
  return true;
}

function openLocalDeploy(directory: string): PreviousDeploy {
  return {
    location: directory,

    async readFile(path) {
      try {
        return new Uint8Array(await readFile(resolve(directory, path)));
      } catch (error) {
        const fileDoesNotExist = (error as NodeJS.ErrnoException).code === 'ENOENT';
        if (fileDoesNotExist) {
          return null;
        }
        throw error;
      }
    },
  };
}
