/**
 * Retry tiles that failed during `fetch-tiles`.
 *
 * Reads one URI per line from `<output>/failures.txt` (written by
 * `fetch-tiles`), retries each with a slower backoff, strips textures like the
 * main fetch, and rewrites the file with whatever is still failing. Successful
 * tiles are removed from the list.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { stripB3dmTextures } from './strip-b3dm.mjs';

const DEFAULT_BASE =
  'https://www.onemap.gov.sg/omapi/tilesets/sg_noterrain_tiles/';
const REFERER = 'https://www.onemap.gov.sg/3d';

const args = process.argv.slice(2);
const outputArg = args.find((arg) => arg.startsWith('--output='));
const OUTPUT_DIR = outputArg ? outputArg.split('=')[1] : 'tiles';
const inputArg = args.find((arg) => arg.startsWith('--input='));
const FAILURES_FILE = inputArg
  ? inputArg.split('=')[1]
  : join(OUTPUT_DIR, 'failures.txt');
const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));
const concurrency = concurrencyArg
  ? Number(concurrencyArg.split('=')[1])
  : 2;
const retriesArg = args.find((arg) => arg.startsWith('--retries='));
const retries = retriesArg ? Number(retriesArg.split('=')[1]) : 5;
const baseArg = args.find((arg) => arg.startsWith('--base-url='));
const baseUrl = new URL(baseArg ? baseArg.split('=')[1] : DEFAULT_BASE);

if (
  !OUTPUT_DIR ||
  !Number.isFinite(concurrency) ||
  concurrency < 1 ||
  !Number.isFinite(retries) ||
  retries < 1
) {
  console.error('Invalid --output, --concurrency or --retries value.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function localPathFor(uri) {
  const root = resolve(OUTPUT_DIR);
  const path = resolve(root, uri.split('?')[0]);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`Refusing to write outside ${OUTPUT_DIR}: ${uri}`);
  }
  return path;
}

async function request(uri) {
  const url = new URL(uri, baseUrl).href;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { Referer: REFERER } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (error) {
      if (attempt >= retries) throw error;
      const delay = Math.min(30000, 2000 * 2 ** (attempt - 1));
      console.warn(`  retrying ${uri} in ${delay}ms (${error.message})`);
      await sleep(delay);
    }
  }
}

let uris;
try {
  uris = (await readFile(FAILURES_FILE, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log(`No failures file at ${FAILURES_FILE}; nothing to retry.`);
    process.exit(0);
  }
  throw error;
}

uris = [...new Set(uris)];
if (!uris.length) {
  console.log('Failures file is empty; nothing to retry.');
  process.exit(0);
}

console.log(`Retrying ${uris.length} tiles from ${FAILURES_FILE}...`);

let next = 0;
let recovered = 0;
let downloadedBytes = 0;
let writtenBytes = 0;
const remaining = [];

async function worker() {
  while (next < uris.length) {
    const uri = uris[next++];
    try {
      const response = await request(uri);
      const buffer = Buffer.from(await response.arrayBuffer());
      downloadedBytes += buffer.byteLength;
      const output = stripB3dmTextures(buffer);
      const localPath = localPathFor(uri);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, output);
      writtenBytes += output.byteLength;
      recovered++;
      console.log(
        `  recovered ${uri} (${formatBytes(buffer.byteLength)} -> ${formatBytes(output.byteLength)})`,
      );
    } catch (error) {
      remaining.push({ uri, message: error.message });
      console.error(`  still failing ${uri}: ${error.message}`);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, () => worker()),
);

console.log(
  `Retried ${uris.length} tiles: ${recovered} recovered, ` +
    `${remaining.length} still failing.`,
);
console.log(
  `Downloaded ${formatBytes(downloadedBytes)}, wrote ${formatBytes(writtenBytes)}.`,
);

if (remaining.length) {
  await writeFile(
    FAILURES_FILE,
    remaining.map((failure) => failure.uri).join('\n') + '\n',
  );
  process.exitCode = 1;
} else {
  await rm(FAILURES_FILE, { force: true });
}
