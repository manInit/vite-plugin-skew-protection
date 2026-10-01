import type { KeepPolicy } from './manifest';

export interface RecoverOptions {
  /**
   * Don't reload again if the previous automatic reload happened less than this many ms ago.
   * Protects against reload loops when the site is really broken.
   * @default 10000
   */
  cooldownMs?: number;
}

export interface SkewProtectionOptions {
  /**
   * Where the currently deployed version lives. Old chunks are copied from here into the new build.
   * - a URL of the live site (including the base path), e.g. `https://example.com/app/`
   * - a local directory, e.g. a CI cache or a copy of the previous `dist`
   * - `false` to disable carrying old chunks (recovery only)
   *
   * Falls back to the `SKEW_PREVIOUS_URL` environment variable.
   */
  previous?: string | false;
  /**
   * How long old chunks stay available.
   * @default { deploys: 5, days: 7 }
   */
  keep?: { deploys?: number; days?: number };
  /**
   * Reload the page once when a chunk still fails to load.
   * @default true
   */
  recover?: boolean | RecoverOptions;
  /** Id of this build. Defaults to `SKEW_BUILD_ID`, common CI commit variables, or a random id. */
  buildId?: string;
  /**
   * Which emitted files are versioned assets worth carrying forward.
   * Defaults to every emitted file. HTML, the skew manifest and `.vite/` are never carried.
   */
  include?: (fileName: string) => boolean;
  /**
   * Fail the build when the previous deploy can't be reached (network error, 5xx).
   * A missing manifest (first deploy: 404, 410 or 403) is never an error.
   * @default false
   */
  strict?: boolean;
  /** Extra headers for requests to `previous`, e.g. basic auth for a staging site. */
  headers?: Record<string, string>;
  /** Parallel downloads. @default 8 */
  concurrency?: number;
  /** Request timeout in ms. @default 15000 */
  timeoutMs?: number;
  /** @default 'skew-manifest.json' */
  manifestFileName?: string;
  /** Custom fetch, mainly for tests. */
  fetch?: typeof globalThis.fetch;
}

export const DEFAULTS = {
  keep: { deploys: 5, days: 7 },
  cooldownMs: 10_000,
  strict: false,
  concurrency: 8,
  timeoutMs: 15_000,
  manifestFileName: 'skew-manifest.json',
} as const;

/** Options with every default filled in. */
export interface ResolvedOptions {
  previous: string | false;
  keep: KeepPolicy;
  /** `false` when recovery is disabled. */
  recover: { cooldownMs: number } | false;
  buildId: string | undefined;
  include: ((fileName: string) => boolean) | undefined;
  strict: boolean;
  headers: Record<string, string> | undefined;
  concurrency: number;
  timeoutMs: number;
  manifestFileName: string;
  fetch: typeof globalThis.fetch | undefined;
}

export function resolveOptions(options: SkewProtectionOptions): ResolvedOptions {
  const recoverOptions = typeof options.recover === 'object' ? options.recover : {};

  return {
    previous: options.previous ?? process.env.SKEW_PREVIOUS_URL ?? false,
    keep: {
      deploys: options.keep?.deploys ?? DEFAULTS.keep.deploys,
      days: options.keep?.days ?? DEFAULTS.keep.days,
    },
    recover: options.recover === false ? false : { cooldownMs: recoverOptions.cooldownMs ?? DEFAULTS.cooldownMs },
    buildId: options.buildId,
    include: options.include,
    strict: options.strict ?? DEFAULTS.strict,
    headers: options.headers,
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    manifestFileName: options.manifestFileName ?? DEFAULTS.manifestFileName,
    fetch: options.fetch,
  };
}
