import { describeChunk } from './chunk';

// Excluded with `include` in `vite.config.ts`: the next deploy deletes this file, like a host without the plugin.
export const info = describeChunk(import.meta.url);
