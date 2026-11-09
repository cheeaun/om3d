/**
 * Copy only the files the demo needs from ./optimized-tiles into ./dist.
 *
 * The final tileset is checked in; only tileset.json and *.b3dm are copied.
 */
import { cp, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const SOURCE = 'optimized-tiles';
const DEST = 'dist/optimized-tiles';

if (!existsSync(SOURCE)) {
  console.error(`Missing ${SOURCE}. Run \`npm run build-toy-tiles\` first.`);
  process.exit(1);
}

await rm(DEST, { recursive: true, force: true });
await cp(SOURCE, DEST, {
  recursive: true,
  filter: (src) => {
    if (!existsSync(src)) return true;
    if (statSync(src).isDirectory()) return true;
    return basename(src) === 'tileset.json' || src.endsWith('.b3dm');
  },
});
