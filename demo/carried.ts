import { describeChunk } from './chunk';

// A lazy chunk like any other: the plugin copies it into the next deploys.
export const info = describeChunk(import.meta.url);
