export interface ChunkInfo {
  fileName: string;
  buildId: string;
}

/** Tells which file a lazy chunk was loaded from and which build made it. */
export function describeChunk(chunkUrl: string): ChunkInfo {
  const fileName = new URL(chunkUrl).pathname.split('/').pop() ?? chunkUrl;
  return { fileName, buildId: __BUILD_ID__ };
}
