/**
 * Download the OneMap 3D tileset and all of its tiles.
 *
 * The current OneMap 3D tileset is huge (tens of thousands of tiles, well over
 * 100 GB). Use `--dry-run` first, and `--max-level` to mirror only the coarse
 * levels. `--strip-textures` drops the photogrammetry images and keeps only
 * geometry, which cuts the output to a few GB. `--max-bytes` limits the number
 * of bytes written to disk. The old `www.onemap3d.gov.sg/files/sg_3dtiles/...`
 * endpoint has been retired; the tileset now lives under
 * `www.onemap.gov.sg/omapi/tilesets/`.
 *
 * Failed URIs are written to `<output>/failures.txt`; retry them with
 * `node scripts/retry-failed-tiles.mjs --output=<output>`.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { stripB3dmTextures } from './strip-b3dm.mjs';

const TILESET_URL =
  process.env.ONEMAP_3D_TILESET_URL ??
  'https://www.onemap.gov.sg/omapi/tilesets/sg_noterrain_tiles/tileset.json';
const REFERER = 'https://www.onemap.gov.sg/3d';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const stripTextures = args.includes('--strip-textures');
const outputArg = args.find((arg) => arg.startsWith('--output='));
const OUTPUT_DIR = outputArg ? outputArg.split('=')[1] : 'tiles';
const maxLevelArg = args.find((arg) => arg.startsWith('--max-level='));
const maxLevel = maxLevelArg ? Number(maxLevelArg.split('=')[1]) : Infinity;
const maxBytesArg = args.find((arg) => arg.startsWith('--max-bytes='));
const maxBytes = maxBytesArg ? Number(maxBytesArg.split('=')[1]) : Infinity;
const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));
const concurrency = concurrencyArg
  ? Number(concurrencyArg.split('=')[1])
  : 8;

if (
  !OUTPUT_DIR ||
  (maxLevelArg && (!Number.isFinite(maxLevel) || maxLevel < 0)) ||
  (maxBytesArg && (!Number.isFinite(maxBytes) || maxBytes <= 0)) ||
  !Number.isFinite(concurrency) ||
  concurrency < 1
) {
  console.error('Invalid --output, --max-level, --max-bytes or --concurrency value.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, { retries = 4 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Referer: REFERER },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (error) {
      if (attempt >= retries) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(`  retrying in ${delay}ms (${error.message})`);
      await sleep(delay);
    }
  }
}

function collectContentUris(root) {
  const uris = new Set();
  const walk = (node) => {
    const uri = node.content?.uri ?? node.content?.url;
    if (uri) uris.add(uri);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return [...uris];
}

function levelOf(uri) {
  const first = uri.split('/')[0];
  // Old-style tiles are stored as `data/dataN.b3dm`; treat them as level 0.
  return /^\d+$/.test(first) ? Number(first) : 0;
}

function localPathFor(uri) {
  const root = resolve(OUTPUT_DIR);
  const path = resolve(root, uri.split('?')[0]);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`Refusing to write outside ${OUTPUT_DIR}: ${uri}`);
  }
  return path;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

console.log(`Fetching ${TILESET_URL}`);
const response = await request(TILESET_URL);
const tileset = await response.text();
const tilesetJson = JSON.parse(tileset); // fail fast on an HTML error page

const allUris = collectContentUris(tilesetJson.root);
const uris = allUris.filter((uri) => levelOf(uri) <= maxLevel);

console.log(
  `${allUris.length} tiles in the tileset, ${uris.length} selected` +
    (maxLevel === Infinity ? '' : ` (max level ${maxLevel})`) +
    '.',
);

if (dryRun) {
  console.log('Dry run: nothing was downloaded.');
  process.exit(0);
}

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(join(OUTPUT_DIR, 'tileset.json'), tileset);

if (stripTextures) {
  console.log('Stripping textures from each tile.');
}

if (uris.length > 3000) {
  console.warn(
    `⚠️  This will download a very large amount of data (${uris.length} tiles).` +
      ' Consider --max-level, --strip-textures, or a higher --concurrency.',
  );
}

const baseUrl = new URL('.', TILESET_URL);
let next = 0;
let done = 0;
let downloadedBytes = 0;
let writtenBytes = Buffer.byteLength(tileset);
const failures = [];

async function worker() {
  while (next < uris.length && writtenBytes < maxBytes) {
    const uri = uris[next++];
    const localPath = localPathFor(uri);
    const url = new URL(uri, baseUrl).href;
    try {
      const tileResponse = await request(url);
      const buffer = Buffer.from(await tileResponse.arrayBuffer());
      downloadedBytes += buffer.byteLength;
      const output = stripTextures ? stripB3dmTextures(buffer) : buffer;
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, output);
      writtenBytes += output.byteLength;
      done++;
      if (done % 100 === 0 || done === uris.length) {
        console.log(
          `  ${done}/${uris.length} tiles ` +
            `(downloaded ${formatBytes(downloadedBytes)}, ` +
            `written ${formatBytes(writtenBytes)})`,
        );
      }
    } catch (error) {
      failures.push({ uri, message: error.message });
      console.error(`  failed ${uri}: ${error.message}`);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, () => worker()),
);

console.log(
  `Saved ${done} tiles (downloaded ${formatBytes(downloadedBytes)}, ` +
    `written ${formatBytes(writtenBytes)}).`,
);
if (writtenBytes >= maxBytes) {
  console.log(
    `Reached --max-bytes=${maxBytes} (${formatBytes(writtenBytes)} written); stopped.`,
  );
}
if (failures.length) {
  await writeFile(
    join(OUTPUT_DIR, 'failures.txt'),
    failures.map((failure) => failure.uri).join('\n') + '\n',
  );
  console.error(`${failures.length} tiles failed:`);
  for (const failure of failures) {
    console.error(`  ${failure.uri}: ${failure.message}`);
  }
  process.exitCode = 1;
} else {
  await rm(join(OUTPUT_DIR, 'failures.txt'), { force: true });
}
