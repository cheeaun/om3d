/**
 * Build a hole-free, simplified tileset from a stripped OneMap download.
 *
 * Source:  tiles/ (geometry only, produced by fetch-tiles --strip-textures)
 * Output:  optimized-tiles/
 *
 * Selection:
 *   - keep every content tile up to --max-depth (default 8)
 *   - for branches with no content by that depth, descend to the first
 *     available content tile and use it as filler, so nothing goes blank
 *   - missing source files are treated as empty and filled from a descendant
 *
 * Simplification:
 *   - decode the Draco geometry
 *   - split triangles by _BATCHID so buildings stay distinct
 *   - weld and simplify each batch with meshoptimizer
 *   - protect landmark batches (Merlion by default)
 *   - rebuild the GLB, compress it with gltfpack -c, and repack the B3DM
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';

const execFileAsync = promisify(execFile);
await MeshoptSimplifier.ready;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const arg = args.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
};

const SOURCE = resolve(getArg('source', 'tiles'));
const OUTPUT = resolve(getArg('output', 'optimized-tiles'));
const MAX_DEPTH = Number(getArg('max-depth', 8));
const RATIO = Number(getArg('ratio', 0.5));
const ERROR = Number(getArg('error', 0.005));
const MIN_TRIS = Number(getArg('min-tris', 20));
const CONCURRENCY = Number(getArg('concurrency', 4));
const SHARP = !args.includes('--no-sharp');
const NORMAL_AWARE = args.includes('--normal-aware');
const NORMAL_WEIGHT = Number(getArg('normal-weight', 4));
const FOOTPRINT = args.includes('--reconstruct=footprint');
const STRIP_METADATA = args.includes('--strip-metadata');
const DRY_RUN = args.includes('--dry-run');
const LIMIT = getArg('limit', null);
const OFFSET = Number(getArg('offset', 0));
const ONLY = getArg('only', null);
const BOUNDS = (() => {
  const raw = getArg('bounds', null);
  if (!raw) return null;
  const values = raw.split(',').map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) return null;
  return values.map((value) => (value * Math.PI) / 180);
})();
const DEEP_AREAS = args
  .filter((item) => item.startsWith('--deep-area='))
  .map((item) => {
    const [west, south, east, north, depth] = item
      .slice('--deep-area='.length)
      .split(',')
      .map(Number);
    if (
      ![west, south, east, north, depth].every(Number.isFinite) ||
      depth < 0
    ) {
      return null;
    }
    return {
      west: (west * Math.PI) / 180,
      south: (south * Math.PI) / 180,
      east: (east * Math.PI) / 180,
      north: (north * Math.PI) / 180,
      depth,
    };
  })
  .filter(Boolean);

const PROTECT = [[1.2868, 103.8545, 30]]; // Merlion Park
for (const arg of args.filter((item) => item.startsWith('--protect='))) {
  const [lat, lng, radius] = arg.slice('--protect='.length).split(',').map(Number);
  if ([lat, lng, radius].every(Number.isFinite)) PROTECT.push([lat, lng, radius]);
}

if (
  !Number.isFinite(MAX_DEPTH) ||
  MAX_DEPTH < 0 ||
  !Number.isFinite(RATIO) ||
  RATIO <= 0 ||
  RATIO > 1 ||
  !Number.isFinite(ERROR) ||
  ERROR <= 0 ||
  !Number.isFinite(MIN_TRIS) ||
  MIN_TRIS < 0 ||
  !Number.isFinite(CONCURRENCY) ||
  CONCURRENCY < 1 ||
  (getArg('bounds', null) && !BOUNDS)
) {
  console.error(
    'Invalid --max-depth, --ratio, --error, --min-tris, --concurrency or --bounds value.',
  );
  process.exit(1);
}

const TILESET_PATH = join(SOURCE, 'tileset.json');
const tileset = JSON.parse(await readFile(TILESET_PATH, 'utf8'));

const existsCache = new Map();
function contentExists(uri) {
  if (!existsCache.has(uri)) {
    existsCache.set(uri, existsSync(join(SOURCE, uri.split('?')[0])));
  }
  return existsCache.get(uri);
}

const selected = new Set();
const missing = new Set();
const fallbacks = [];
const unfillableList = [];
let unfillable = 0;

function select(node, depth, covered) {
  const region = node.boundingVolume?.region;
  if (BOUNDS && region) {
    const [west, south, east, north] = region;
    if (
      west > BOUNDS[2] ||
      east < BOUNDS[0] ||
      south > BOUNDS[3] ||
      north < BOUNDS[1]
    ) {
      return null;
    }
  }

  const uri = node.content?.uri ?? node.content?.url;
  const exists = Boolean(uri && contentExists(uri));
  if (uri && !exists) missing.add(uri);

  let maxDepth = MAX_DEPTH;
  if (region) {
    const [west, south, east, north] = region;
    for (const area of DEEP_AREAS) {
      if (
        west <= area.east &&
        east >= area.west &&
        south <= area.north &&
        north >= area.south
      ) {
        maxDepth = Math.max(maxDepth, area.depth);
      }
    }
  }

  const keepContent = exists && (depth <= maxDepth || !covered);
  const nextCovered = covered || keepContent;
  if (keepContent) {
    selected.add(uri);
    if (depth > maxDepth || (uri && !exists)) fallbacks.push({ uri, depth });
  }

  const recurse = depth < maxDepth || !nextCovered;
  const children = [];
  if (recurse) {
    for (const child of node.children ?? []) {
      const result = select(child, depth + 1, nextCovered);
      if (result) children.push(result);
    }
  }

  if (!keepContent && !children.length) {
    if (uri && !exists) {
      unfillable++;
      unfillableList.push({
        uri,
        depth,
        boundingVolume: node.boundingVolume,
      });
    }
    return null;
  }

  const out = { ...node };
  if (keepContent) out.content = node.content;
  else delete out.content;

  if (children.length) {
    out.children = children;
  } else {
    delete out.children;
    out.geometricError = 0;
  }
  return out;
}

const root = select(tileset.root, 0, false);
if (!root) {
  console.error('Selection produced an empty tileset.');
  process.exit(1);
}

const outputTileset = {
  asset: tileset.asset,
  properties: tileset.properties,
  geometricError: tileset.geometricError,
  root,
};

let selectedBytes = 0;
for (const uri of selected) {
  try {
    selectedBytes += (await stat(join(SOURCE, uri))).size;
  } catch {
    // already tracked as missing
  }
}

console.log(
  `Selected ${selected.size} tiles (${(selectedBytes / 2 ** 20).toFixed(1)} MiB).`,
);
console.log(
  `Missing source tiles: ${missing.size}; fallback tiles: ${fallbacks.length}; unfillable branches: ${unfillable}.`,
);
if (missing.size) {
  console.log(`Missing: ${[...missing].slice(0, 10).join(', ')}${missing.size > 10 ? ', …' : ''}`);
}
if (unfillableList.length) {
  console.log('Unfillable branches:');
  for (const branch of unfillableList) {
    console.log(`  depth ${branch.depth}: ${branch.uri} ${JSON.stringify(branch.boundingVolume)}`);
  }
}

if (DRY_RUN) {
  process.exit(0);
}

await mkdir(OUTPUT, { recursive: true });
await writeFile(join(OUTPUT, 'tileset.json'), JSON.stringify(outputTileset));

function localPath(rootDir, uri) {
  const rootPath = resolve(rootDir);
  const target = resolve(rootPath, uri.split('?')[0]);
  if (target !== rootPath && !target.startsWith(rootPath + sep)) {
    throw new Error(`Refusing to write outside ${rootDir}: ${uri}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// B3DM / GLB helpers
// ---------------------------------------------------------------------------

const B3DM_MAGIC = 0x6d643362;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

function parseB3dm(buffer) {
  if (buffer.readUInt32LE(0) !== B3DM_MAGIC) throw new Error('not a B3DM');
  const ftj = buffer.readUInt32LE(12);
  const ftb = buffer.readUInt32LE(16);
  const btj = buffer.readUInt32LE(20);
  const btb = buffer.readUInt32LE(24);
  const tablesLength = ftj + ftb + btj + btb;
  return {
    header: buffer.subarray(0, 28),
    tables: buffer.subarray(28, 28 + tablesLength),
    glb: buffer.subarray(28 + tablesLength),
    ftj,
    ftb,
    btj,
    btb,
  };
}

function parseGlb(glb) {
  if (glb.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const data = glb.subarray(offset + 8, offset + 8 + length);
    if (type === GLB_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === GLB_BIN) bin = data;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function writeGlb(json, bin) {
  let jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonChunk.length % 4)) % 4;
  if (jsonPad) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPad, 0x20)]);

  let binChunk = bin ?? Buffer.alloc(0);
  const binPad = (4 - (binChunk.length % 4)) % 4;
  if (binPad) binChunk = Buffer.concat([binChunk, Buffer.alloc(binPad)]);

  const total =
    12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(GLB_JSON, 16);
  jsonChunk.copy(out, 20);

  let offset = 20 + jsonChunk.length;
  if (binChunk.length) {
    out.writeUInt32LE(binChunk.length, offset);
    out.writeUInt32LE(GLB_BIN, offset + 4);
    binChunk.copy(out, offset + 8);
  }
  return out;
}

function buildB3dm(header, tables, glb) {
  const total = 28 + tables.length + glb.length;
  const out = Buffer.alloc(total);
  header.copy(out, 0, 0, 28);
  out.writeUInt32LE(total, 8);
  tables.copy(out, 28);
  glb.copy(out, 28 + tables.length);
  return out;
}

function buildStrippedB3dm(parsed, glb) {
  const featureJson = JSON.parse(
    parsed.tables.subarray(0, parsed.ftj).toString('utf8'),
  );
  featureJson.BATCH_LENGTH = 0;
  let featureJsonBuffer = Buffer.from(JSON.stringify(featureJson), 'utf8');
  const pad = (8 - (featureJsonBuffer.length % 8)) % 8;
  if (pad) featureJsonBuffer = Buffer.concat([featureJsonBuffer, Buffer.alloc(pad, 0x20)]);
  const featureBinary = parsed.tables.subarray(
    parsed.ftj,
    parsed.ftj + parsed.ftb,
  );
  const tables = Buffer.concat([featureJsonBuffer, featureBinary]);
  const header = Buffer.from(parsed.header);
  header.writeUInt32LE(featureJsonBuffer.length, 12);
  header.writeUInt32LE(featureBinary.length, 16);
  header.writeUInt32LE(0, 20);
  header.writeUInt32LE(0, 24);
  return buildB3dm(header, tables, glb);
}

// ---------------------------------------------------------------------------
// Geometry decoding and simplification
// ---------------------------------------------------------------------------

function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat1 - lat2) * 111320;
  const dLng = (lng1 - lng2) * 111320 * Math.cos((lat2 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function protectedBatches(buffer, b3dm) {
  if (!b3dm.btj) return new Set();
  const bufferOffset =
    28 +
    buffer.readUInt32LE(12) +
    buffer.readUInt32LE(16);
  const batchTable = JSON.parse(
    buffer
      .subarray(bufferOffset, bufferOffset + b3dm.btj)
      .toString('utf8'),
  );
  const lat = batchTable.Latitude;
  const lng = batchTable.Longitude;
  if (!lat || !lng) return new Set();
  const protectedSet = new Set();
  for (let i = 0; i < lat.length; i++) {
    for (const [pLat, pLng, radius] of PROTECT) {
      if (distanceMeters(lat[i], lng[i], pLat, pLng) <= radius) {
        protectedSet.add(i);
        break;
      }
    }
  }
  return protectedSet;
}

function decodePrimitive(json, bin, primitive, decoderModule) {
  const extension = primitive.extensions?.['KHR_draco_mesh_compression'];
  if (!extension) throw new Error('primitive is not Draco-compressed');
  const view = json.bufferViews[extension.bufferView];
  const data = bin.subarray(
    view.byteOffset ?? 0,
    (view.byteOffset ?? 0) + view.byteLength,
  );
  const decoder = new decoderModule.Decoder();
  const decoderBuffer = new decoderModule.DecoderBuffer();
  decoderBuffer.Init(
    new Int8Array(data.buffer, data.byteOffset, data.byteLength),
    data.byteLength,
  );
  const mesh = new decoderModule.Mesh();
  const status = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
  if (!status.ok()) throw new Error('Draco decode failed');

  const readAttribute = (id, components) => {
    const attribute = decoder.GetAttributeByUniqueId(mesh, id);
    const values = new decoderModule.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attribute, values);
    const out = new Float32Array(mesh.num_points() * components);
    for (let i = 0; i < out.length; i++) out[i] = values.GetValue(i);
    values.destroy?.();
    attribute.destroy?.();
    return out;
  };

  try {
    const indexCount = mesh.num_faces() * 3;
    const indexBytes = indexCount * 4;
    const pointer = decoderModule._malloc(indexBytes);
    try {
      decoder.GetTrianglesUInt32Array(mesh, indexBytes, pointer);
      return {
        positions: readAttribute(extension.attributes.POSITION, 3),
        normals:
          extension.attributes.NORMAL != null
            ? readAttribute(extension.attributes.NORMAL, 3)
            : null,
        batchIds:
          extension.attributes._BATCHID != null
            ? readAttribute(extension.attributes._BATCHID, 1)
            : null,
        indices: new Uint32Array(
          decoderModule.HEAPU8.buffer,
          pointer,
          indexCount,
        ).slice(),
      };
    } finally {
      decoderModule._free(pointer);
    }
  } finally {
    mesh.destroy?.();
    decoderBuffer.destroy?.();
    decoder.destroy?.();
  }
}

function weld(positions, indices, quantum = 1e-3, normals = null) {
  const map = new Map();
  const outPositions = [];
  const outIndices = [];
  const outNormals = normals ? [] : null;
  for (const index of indices) {
    let key =
      `${Math.round(positions[index * 3] / quantum)},` +
      `${Math.round(positions[index * 3 + 1] / quantum)},` +
      `${Math.round(positions[index * 3 + 2] / quantum)}`;
    if (normals) {
      key +=
        `|${Math.round(normals[index * 3] / 0.01)},` +
        `${Math.round(normals[index * 3 + 1] / 0.01)},` +
        `${Math.round(normals[index * 3 + 2] / 0.01)}`;
    }
    let next = map.get(key);
    if (next == null) {
      next = outPositions.length / 3;
      map.set(key, next);
      outPositions.push(
        positions[index * 3],
        positions[index * 3 + 1],
        positions[index * 3 + 2],
      );
      if (outNormals) {
        outNormals.push(
          normals[index * 3],
          normals[index * 3 + 1],
          normals[index * 3 + 2],
        );
      }
    }
    outIndices.push(next);
  }
  return {
    positions: new Float32Array(outPositions),
    normals: outNormals ? new Float32Array(outNormals) : null,
    indices: new Uint32Array(outIndices),
  };
}

function weldPositionNormals(positions, normals, indices, quantum = 1e-3) {
  const map = new Map();
  const outPositions = [];
  const outNormals = [];
  const outCounts = [];
  const outIndices = [];
  for (const index of indices) {
    const key =
      `${Math.round(positions[index * 3] / quantum)},` +
      `${Math.round(positions[index * 3 + 1] / quantum)},` +
      `${Math.round(positions[index * 3 + 2] / quantum)}`;
    let next = map.get(key);
    if (next == null) {
      next = outPositions.length / 3;
      map.set(key, next);
      outPositions.push(
        positions[index * 3],
        positions[index * 3 + 1],
        positions[index * 3 + 2],
      );
      outNormals.push(0, 0, 0);
      outCounts.push(0);
    }
    outNormals[next * 3] += normals[index * 3];
    outNormals[next * 3 + 1] += normals[index * 3 + 1];
    outNormals[next * 3 + 2] += normals[index * 3 + 2];
    outCounts[next]++;
    outIndices.push(next);
  }
  for (let i = 0; i < outNormals.length; i += 3) {
    const length = Math.hypot(
      outNormals[i],
      outNormals[i + 1],
      outNormals[i + 2],
    );
    if (length > 0) {
      outNormals[i] /= length;
      outNormals[i + 1] /= length;
      outNormals[i + 2] /= length;
    } else {
      outNormals[i + 2] = 1;
    }
  }
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    indices: new Uint32Array(outIndices),
  };
}

function compact(positions, indices, normals = null) {
  const map = new Map();
  const outPositions = [];
  const outIndices = [];
  const outNormals = normals ? [] : null;
  for (const index of indices) {
    let next = map.get(index);
    if (next == null) {
      next = outPositions.length / 3;
      map.set(index, next);
      outPositions.push(
        positions[index * 3],
        positions[index * 3 + 1],
        positions[index * 3 + 2],
      );
      if (outNormals) {
        outNormals.push(
          normals[index * 3],
          normals[index * 3 + 1],
          normals[index * 3 + 2],
        );
      }
    }
    outIndices.push(next);
  }
  return {
    positions: new Float32Array(outPositions),
    normals: outNormals ? new Float32Array(outNormals) : null,
    indices: new Uint32Array(outIndices),
  };
}

function recomputeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const abx = positions[b * 3] - ax;
    const aby = positions[b * 3 + 1] - ay;
    const abz = positions[b * 3 + 2] - az;
    const acx = positions[c * 3] - ax;
    const acy = positions[c * 3 + 1] - ay;
    const acz = positions[c * 3 + 2] - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const index of [a, b, c]) {
      normals[index * 3] += nx;
      normals[index * 3 + 1] += ny;
      normals[index * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (length > 0) {
      normals[i] /= length;
      normals[i + 1] /= length;
      normals[i + 2] /= length;
    } else {
      normals[i + 2] = 1;
    }
  }
  return normals;
}

function meshBatches(primitive, protectedSet) {
  const groups = new Map();
  for (let i = 0; i < primitive.indices.length; i += 3) {
    const a = primitive.indices[i];
    const b = primitive.indices[i + 1];
    const c = primitive.indices[i + 2];
    const batch = primitive.batchIds ? Math.round(primitive.batchIds[a]) : 0;
    const same =
      !primitive.batchIds ||
      (Math.round(primitive.batchIds[b]) === batch &&
        Math.round(primitive.batchIds[c]) === batch);
    if (!same) throw new Error('triangle spans multiple batches');
    if (!groups.has(batch)) groups.set(batch, []);
    groups.get(batch).push(a, b, c);
  }
  for (const [batch, triangles] of groups) {
    const map = new Map();
    const indices = [];
    for (const index of triangles) {
      let next = map.get(index);
      if (next == null) {
        next = map.size;
        map.set(index, next);
      }
      indices.push(next);
    }
    const positions = new Float32Array(map.size * 3);
    const normals = primitive.normals
      ? new Float32Array(map.size * 3)
      : null;
    for (const [index, next] of map) {
      positions[next * 3] = primitive.positions[index * 3];
      positions[next * 3 + 1] = primitive.positions[index * 3 + 1];
      positions[next * 3 + 2] = primitive.positions[index * 3 + 2];
      if (normals) {
        normals[next * 3] = primitive.normals[index * 3];
        normals[next * 3 + 1] = primitive.normals[index * 3 + 1];
        normals[next * 3 + 2] = primitive.normals[index * 3 + 2];
      }
    }
    groups.set(batch, {
      indices: new Uint32Array(indices),
      positions,
      normals,
      protected: protectedSet.has(batch),
    });
  }
  return groups;
}

function simplifyBatch(group, forceKeep = false) {
  const originalTriangles = group.indices.length / 3;
  if (forceKeep || group.protected || originalTriangles <= MIN_TRIS) {
    return {
      positions: group.positions,
      normals:
        group.normals ?? recomputeNormals(group.positions, group.indices),
      indices: group.indices,
      triangles: originalTriangles,
    };
  }

  if (NORMAL_AWARE && group.normals) {
    const welded = weldPositionNormals(
      group.positions,
      group.normals,
      group.indices,
    );
    const targetCount = Math.max(
      3,
      Math.floor((welded.indices.length * RATIO) / 3) * 3,
    );
    let simplified = welded.indices;
    try {
      const [result] = MeshoptSimplifier.simplifyWithAttributes(
        welded.indices,
        welded.positions,
        3,
        welded.normals,
        3,
        [NORMAL_WEIGHT],
        null,
        targetCount,
        ERROR,
        ['LockBorder'],
      );
      if (result.length) simplified = result;
    } catch {
      // Keep the welded mesh if the simplifier cannot improve it.
    }
    const compacted = compact(
      welded.positions,
      simplified,
      welded.normals,
    );
    return {
      positions: compacted.positions,
      normals: compacted.normals,
      indices: compacted.indices,
      triangles: compacted.indices.length / 3,
    };
  }

  const welded = weld(
    group.positions,
    group.indices,
    1e-3,
    SHARP ? group.normals : null,
  );
  const targetCount = Math.max(
    3,
    Math.floor((welded.indices.length * RATIO) / 3) * 3,
  );
  let simplified = welded.indices;
  try {
    const [result] = MeshoptSimplifier.simplify(
      welded.indices,
      welded.positions,
      3,
      targetCount,
      ERROR,
      ['LockBorder'],
    );
    if (result.length) simplified = result;
  } catch {
    // Keep the welded mesh if the simplifier cannot improve it.
  }
  const compacted = compact(
    welded.positions,
    simplified,
    SHARP ? welded.normals : null,
  );
  return {
    positions: compacted.positions,
    normals:
      SHARP && compacted.normals
        ? compacted.normals
        : recomputeNormals(compacted.positions, compacted.indices),
    indices: compacted.indices,
    triangles: compacted.indices.length / 3,
  };
}

function convexHull(points) {
  const unique = new Map();
  for (const [x, y] of points) {
    const key = `${Math.round(x * 10)},${Math.round(y * 10)}`;
    if (!unique.has(key)) unique.set(key, [x, y]);
  }
  const sorted = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function footprintGeometry(positions) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  const allPoints = [];
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 2];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    allPoints.push([positions[i], positions[i + 1], z]);
  }
  const height = maxZ - minZ;
  if (!Number.isFinite(height) || height < 1) return null;

  // Sample a mid-height band so connected complexes (for example the MBS
  // towers joined by the SkyPark) separate into individual shafts. Ground and
  // roof-only points otherwise merge everything into one hull.
  const bandMin = minZ + height * 0.35;
  const bandMax = minZ + height * 0.65;
  let topPoints = allPoints.filter(
    (point) => point[2] >= bandMin && point[2] <= bandMax,
  );
  if (topPoints.length < 3) topPoints = allPoints;

  // Cluster roof points into connected XY cells so separate towers/buildings
  // do not get merged into one giant hull.
  const cellSize = 10;
  const cells = new Map();
  for (const [x, y] of topPoints) {
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push([x, y]);
  }
  const parent = new Map([...cells.keys()].map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== root) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const key of cells.keys()) {
    const [cx, cy] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbor = `${cx + dx},${cy + dy}`;
        if (cells.has(neighbor)) union(key, neighbor);
      }
    }
  }
  const groups = new Map();
  for (const [key, points] of cells) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...points);
  }

  const outPositions = [];
  const outNormals = [];
  const outIndices = [];
  const addVertex = (x, y, z, nx, ny, nz) => {
    outPositions.push(x, y, z);
    outNormals.push(nx, ny, nz);
    return outPositions.length / 3 - 1;
  };

  let added = false;
  for (const points of groups.values()) {
    const hull = convexHull(points);
    if (hull.length < 3) continue;
    const roofZ = maxZ;
    if (roofZ - minZ < 1) continue;
    const start = outIndices.length;
    for (let i = 0; i < hull.length; i++) {
      const [x1, y1] = hull[i];
      const [x2, y2] = hull[(i + 1) % hull.length];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length < 0.5) continue;
      const nx = dy / length;
      const ny = -dx / length;
      const a = addVertex(x1, y1, minZ, nx, ny, 0);
      const b = addVertex(x2, y2, minZ, nx, ny, 0);
      const c = addVertex(x2, y2, roofZ, nx, ny, 0);
      const d = addVertex(x1, y1, roofZ, nx, ny, 0);
      outIndices.push(a, b, c, a, c, d);
    }
    const roof = hull.map(([x, y]) => addVertex(x, y, roofZ, 0, 0, 1));
    for (let i = 1; i < roof.length - 1; i++) {
      outIndices.push(roof[0], roof[i], roof[i + 1]);
    }
    if (outIndices.length > start) added = true;
  }
  if (!added) return null;

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    indices: new Uint32Array(outIndices),
  };
}

function buildFootprintGeometry(glbJson, bin, decoderModule) {
  const meshes = [];
  for (const sourceMesh of glbJson.meshes ?? []) {
    const batches = new Map();
    for (const sourcePrimitive of sourceMesh.primitives ?? []) {
      const primitive = decodePrimitive(
        glbJson,
        bin,
        sourcePrimitive,
        decoderModule,
      );
      for (let i = 0; i < primitive.indices.length; i += 3) {
        const a = primitive.indices[i];
        const b = primitive.indices[i + 1];
        const c = primitive.indices[i + 2];
        const batch = primitive.batchIds
          ? Math.round(primitive.batchIds[a])
          : 0;
        if (!batches.has(batch)) batches.set(batch, []);
        const list = batches.get(batch);
        for (const index of [a, b, c]) {
          list.push(
            primitive.positions[index * 3],
            primitive.positions[index * 3 + 1],
            primitive.positions[index * 3 + 2],
          );
        }
      }
    }

    const positions = [];
    const normals = [];
    const indices = [];
    let vertexOffset = 0;
    for (const list of batches.values()) {
      const footprint = footprintGeometry(new Float32Array(list));
      if (!footprint) continue;
      for (let i = 0; i < footprint.positions.length; i++) {
        positions.push(footprint.positions[i]);
      }
      for (let i = 0; i < footprint.normals.length; i++) {
        normals.push(footprint.normals[i]);
      }
      for (let i = 0; i < footprint.indices.length; i++) {
        indices.push(footprint.indices[i] + vertexOffset);
      }
      vertexOffset += footprint.positions.length / 3;
    }
    if (!positions.length) continue;
    meshes.push({
      attributes: {
        POSITION: new Float32Array(positions),
        NORMAL: new Float32Array(normals),
      },
      indices: new Uint32Array(indices),
    });
  }
  return meshes;
}

function buildGeometry(glbJson, bin, protectedSet, decoderModule) {
  if (FOOTPRINT) {
    return buildFootprintGeometry(glbJson, bin, decoderModule);
  }
  const meshes = [];
  for (const sourceMesh of glbJson.meshes ?? []) {
    const positions = [];
    const normals = [];
    const batchIds = [];
    const indices = [];
    let vertexOffset = 0;

    for (const sourcePrimitive of sourceMesh.primitives ?? []) {
      const primitive = decodePrimitive(
        glbJson,
        bin,
        sourcePrimitive,
        decoderModule,
      );
      const groups = meshBatches(primitive, protectedSet);
      for (const [batch, rawGroup] of groups) {
        const group = simplifyBatch(rawGroup);
        for (let i = 0; i < group.positions.length; i++) {
          positions.push(group.positions[i]);
        }
        for (let i = 0; i < group.normals.length; i++) {
          normals.push(group.normals[i]);
        }
        for (let i = 0; i < group.positions.length / 3; i++) {
          if (!STRIP_METADATA) batchIds.push(batch);
        }
        for (let i = 0; i < group.indices.length; i++) {
          indices.push(group.indices[i] + vertexOffset);
        }
        vertexOffset += group.positions.length / 3;
      }
    }

    if (!positions.length) throw new Error('mesh has no geometry');
    const attributes = {
      POSITION: new Float32Array(positions),
      NORMAL: new Float32Array(normals),
    };
    if (!STRIP_METADATA) {
      attributes._BATCHID = new Float32Array(batchIds);
    }
    meshes.push({
      attributes,
      indices: new Uint32Array(indices),
    });
  }
  return meshes;
}

function buildGlb(sourceJson, meshes) {
  const parts = [];
  let offset = 0;
  const json = {
    asset: { version: '2.0', generator: 'om3d build-toy-tiles' },
    scene: sourceJson.scene ?? 0,
    scenes: sourceJson.scenes ?? [{ nodes: [0] }],
    nodes: sourceJson.nodes ?? [{ mesh: 0 }],
    meshes: [],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
        doubleSided: true,
      },
    ],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };

  const append = (array, componentType, type, count, minimumMaximum) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      offset += pad;
    }
    const bytes = Buffer.from(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    );
    json.bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
    });
    parts.push(bytes);
    offset += bytes.length;
    const accessor = {
      bufferView: json.bufferViews.length - 1,
      componentType,
      count,
      type,
    };
    if (minimumMaximum) Object.assign(accessor, minimumMaximum);
    json.accessors.push(accessor);
    return json.accessors.length - 1;
  };

  for (const mesh of meshes) {
    const positions = mesh.attributes.POSITION;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (positions[i + k] < min[k]) min[k] = positions[i + k];
        if (positions[i + k] > max[k]) max[k] = positions[i + k];
      }
    }
    const attributes = {
      POSITION: append(
        positions,
        5126,
        'VEC3',
        positions.length / 3,
        { min, max },
      ),
      NORMAL: append(
        mesh.attributes.NORMAL,
        5126,
        'VEC3',
        mesh.attributes.NORMAL.length / 3,
      ),
    };
    if (mesh.attributes._BATCHID) {
      attributes._BATCHID = append(
        mesh.attributes._BATCHID,
        5126,
        'SCALAR',
        mesh.attributes._BATCHID.length,
      );
    }
    const use16 = mesh.indices.every((value) => value < 65536);
    const indices = use16
      ? new Uint16Array(mesh.indices)
      : new Uint32Array(mesh.indices);
    const indexAccessor = append(
      indices,
      use16 ? 5123 : 5125,
      'SCALAR',
      indices.length,
    );
    json.meshes.push({
      primitives: [
        {
          attributes,
          indices: indexAccessor,
          material: 0,
          mode: 4,
        },
      ],
    });
  }

  const binary = Buffer.concat(parts);
  json.buffers = [{ byteLength: binary.length }];
  return writeGlb(json, binary);
}

const GLTFPACK = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'gltfpack.cmd' : 'gltfpack',
);
if (!existsSync(GLTFPACK)) {
  console.error('Missing gltfpack. Run `npm install` first.');
  process.exit(1);
}

async function simplifyTile(uri, decoderModule) {
  const input = join(SOURCE, uri);
  const buffer = await readFile(input);
  const parsed = parseB3dm(buffer);
  const { json, bin } = parseGlb(parsed.glb);
  const protectedSet = protectedBatches(buffer, parsed);
  const meshes = buildGeometry(json, bin, protectedSet, decoderModule);
  const uncompressed = buildGlb(json, meshes);

  const tempDir = await mkdtemp(join(tmpdir(), 'om3d-toy-'));
  const tempInput = join(tempDir, 'in.glb');
  const tempOutput = join(tempDir, 'out.glb');
  try {
    await writeFile(tempInput, uncompressed);
    await execFileAsync(GLTFPACK, [
      '-c',
      '-kn',
      '-ke',
      '-i',
      tempInput,
      '-o',
      tempOutput,
    ]);
    const compressed = await readFile(tempOutput);
    const output = STRIP_METADATA
      ? buildStrippedB3dm(parsed, compressed)
      : buildB3dm(parsed.header, parsed.tables, compressed);
    const destination = localPath(OUTPUT, uri);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, output);
    return { outputBytes: output.length, triangles: meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const uris = [...selected];
const filtered = ONLY
  ? [ONLY]
  : uris.slice(
      Number.isFinite(OFFSET) ? OFFSET : 0,
      LIMIT ? (Number.isFinite(OFFSET) ? OFFSET : 0) + Number(LIMIT) : undefined,
    );
let next = 0;
let done = 0;
let outputBytes = 0;
let triangles = 0;
const failures = [];

const decoderModules = await Promise.all(
  Array.from({ length: Math.max(1, CONCURRENCY) }, () =>
    draco3d.createDecoderModule({}),
  ),
);

async function worker(decoderModule) {
  while (next < filtered.length) {
    const uri = filtered[next++];
    try {
      const result = await simplifyTile(uri, decoderModule);
      outputBytes += result.outputBytes;
      triangles += result.triangles;
      done++;
      if (done % 50 === 0 || done === filtered.length) {
        console.log(
          `  ${done}/${filtered.length} tiles (${(outputBytes / 2 ** 20).toFixed(1)} MiB output)`,
        );
      }
    } catch (error) {
      failures.push({ uri, message: error.message });
      // Never leave a hole: keep the original stripped tile.
      const destination = localPath(OUTPUT, uri);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(SOURCE, uri), destination);
      console.error(`  ${uri}: ${error.message} (copied original)`);
    }
  }
}

await Promise.all(decoderModules.map((decoderModule) => worker(decoderModule)));

console.log(`\nBuilt ${done}/${filtered.length} tiles.`);
console.log(`Output: ${(outputBytes / 2 ** 20).toFixed(1)} MiB, ${Math.round(triangles).toLocaleString()} triangles.`);
if (failures.length) {
  console.error(`${failures.length} tiles used the unchanged fallback.`);
  for (const failure of failures.slice(0, 20)) {
    console.error(`  ${failure.uri}: ${failure.message}`);
  }
  process.exitCode = 1;
}
