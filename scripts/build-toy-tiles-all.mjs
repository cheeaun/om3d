/**
 * Run build-toy-tiles in bounded chunks.
 *
 * The Draco/meshoptimizer WASM heap grows over a full run and eventually
 * aborts. Each child process handles at most --chunk-size tiles, so its heap
 * is reset between chunks.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build-toy-tiles.mjs');

const args = process.argv.slice(2);
const once =
  args.some((arg) => arg.startsWith('--only=')) ||
  args.some((arg) => arg.startsWith('--limit=')) ||
  args.some((arg) => arg.startsWith('--offset=')) ||
  args.includes('--dry-run');

const chunkSizeArg = args.find((arg) => arg.startsWith('--chunk-size='));
const chunkSize = chunkSizeArg ? Number(chunkSizeArg.split('=')[1]) : 500;
const passthrough = args.filter((arg) => !arg.startsWith('--chunk-size='));

async function run(extra) {
  const result = await execFileAsync(
    process.execPath,
    [script, ...passthrough, ...extra],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

if (once) {
  await run([]);
  process.exit(0);
}

for (let offset = 0; ; offset += chunkSize) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, ...passthrough, `--offset=${offset}`, `--limit=${chunkSize}`],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  process.stdout.write(stdout);
  if (/Built 0\/(?:0|\d+) tiles/.test(stdout)) break;
}
