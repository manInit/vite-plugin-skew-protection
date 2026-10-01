export function parseJson(fileContents: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fileContents));
  } catch {
    return null;
  }
}

/** Runs `task` for every item, with at most `concurrency` tasks running at the same time. */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift() as T;
      await task(item);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers: Promise<void>[] = [];
  for (let workerNumber = 0; workerNumber < workerCount; workerNumber++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

export function formatSize(bytes: number): string {
  const kilobyte = 1024;
  const megabyte = 1024 * 1024;
  if (bytes < kilobyte) {
    return `${bytes} B`;
  }
  if (bytes < megabyte) {
    return `${(bytes / kilobyte).toFixed(1)} kB`;
  }
  return `${(bytes / megabyte).toFixed(2)} MB`;
}

export function isUrl(value: string): boolean {
  const lowerCaseValue = value.toLowerCase();
  return lowerCaseValue.startsWith('http://') || lowerCaseValue.startsWith('https://');
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
