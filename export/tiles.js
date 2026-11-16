import * as THREE from 'three';
import { LoadingManager } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { B3DMLoader } from '3d-tiles-renderer/three';

import { clipTriangleToRing, ringBounds, triangulateRing } from './geometry.js';

const TILE_MARGIN = 200;

function regionToWorldBounds(frame, region) {
  const [west, south, east, north, minHeight, maxHeight] = region;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 2; i++) {
    const lon = i ? east : west;
    for (let j = 0; j < 2; j++) {
      const lat = j ? north : south;
      for (let k = 0; k < 2; k++) {
        const height = k ? maxHeight : minHeight;
        frame.ellipsoid.getCartographicToPosition(lat, lon, height, v);
        v.applyMatrix4(frame.ecefToWorld);
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.z < minZ) minZ = v.z;
        if (v.z > maxZ) maxZ = v.z;
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

function boundsOverlap(a, b, margin) {
  return !(
    a.maxX < b.minX - margin ||
    a.minX > b.maxX + margin ||
    a.maxZ < b.minZ - margin ||
    a.minZ > b.maxZ + margin
  );
}

export function selectTiles(root, frame, ring, margin = TILE_MARGIN) {
  const ringBox = ringBounds(ring);
  const selected = [];

  const visit = (node) => {
    if (!node) return false;

    let covered = false;
    for (const child of node.children ?? []) {
      if (visit(child)) covered = true;
    }
    if (covered) return true;

    const uri = node.content?.uri ?? node.content?.url;
    if (!uri) return false;

    const region =
      node.content?.boundingVolume?.region ?? node.boundingVolume?.region;
    if (!region) return false;

    const box = regionToWorldBounds(frame, region);
    if (!boundsOverlap(box, ringBox, margin)) return false;

    selected.push({ uri, box });
    return true;
  };

  visit(root);
  return selected;
}

export function createDecoder() {
  const manager = new LoadingManager();
  const gltfLoader = new GLTFLoader(manager);
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  manager.addHandler(/\.(gltf|glb)$/g, gltfLoader);

  const loader = new B3DMLoader(manager);
  loader.adjustmentTransform.makeRotationAxis(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2,
  );
  return loader;
}

export function prepareClipGeometry(ring) {
  return triangulateRing(ring).map((tri) => {
    const points = tri.map((p) => ({ x: p.x, y: p.y }));
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y;
      if (p.y > maxZ) maxZ = p.y;
    }
    return { points, minX, maxX, minZ, maxZ };
  });
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _meshMatrix = new THREE.Matrix4();

function batchAttributeOf(geometry) {
  // The loader lowercases attribute names, so `_BATCHID` arrives as `_batchid`.
  return geometry.getAttribute('_batchid') ?? geometry.getAttribute('_BATCHID');
}

// Human-facing label for a batch, from the tile's batch table. Most OneMap
// buildings have no `gml:name`, so fall back to height and usage.
function describeBatch(batchTable, id) {
  if (!batchTable || id < 0 || id >= (batchTable.count ?? 0)) {
    return { name: `Building ${id + 1}`, detail: '' };
  }
  let name = '';
  let height = null;
  let usage = '';
  try {
    name = String(batchTable.getPropertyArray('gml:name')?.[id] ?? '').trim();
    const heights = batchTable.getPropertyArray('Height');
    height = heights ? Number(heights[id]) : null;
    usage = String(batchTable.getPropertyArray('bldg:usage')?.[id] ?? '').trim();
  } catch {
    // Batch table shape varies; fall through to the generic label.
  }

  if (!name) name = `Building ${id + 1}`;
  const parts = [];
  if (Number.isFinite(height) && height > 0) parts.push(`${height.toFixed(0)} m tall`);
  if (usage) parts.push(`usage ${usage}`);
  return { name, detail: parts.join(' · ') };
}

// Pulls every triangle of a decoded tile out in world space, grouped by building
// (`_BATCHID`) so the Layers list can include or exclude individual buildings.
// This is the expensive half and depends only on the tile, so the caller caches
// it and re-clips cheaply when the drawn polygon changes.
export function extractWorldTriangles(tileScene, frameMatrix) {
  tileScene.updateMatrixWorld(true);

  const batchTable = tileScene.batchTable ?? tileScene.parent?.batchTable ?? null;
  const groups = new Map();

  const groupFor = (batchId) => {
    let group = groups.get(batchId);
    if (!group) {
      const info = describeBatch(batchTable, batchId);
      group = {
        batchId,
        name: info.name,
        detail: info.detail,
        triangles: [],
        triangleMins: [],
      };
      groups.set(batchId, group);
    }
    return group;
  };

  tileScene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;

    const batchAttr = batchAttributeOf(geometry);
    _meshMatrix.multiplyMatrices(frameMatrix, mesh.matrixWorld);
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;

    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;

      _a
        .set(position.getX(ia), position.getY(ia), position.getZ(ia))
        .applyMatrix4(_meshMatrix);
      _b
        .set(position.getX(ib), position.getY(ib), position.getZ(ib))
        .applyMatrix4(_meshMatrix);
      _c
        .set(position.getX(ic), position.getY(ic), position.getZ(ic))
        .applyMatrix4(_meshMatrix);

      const batchId = batchAttr ? Math.round(batchAttr.getX(ia)) : -1;
      const group = groupFor(batchId);
      group.triangles.push(
        _a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z,
      );
      group.triangleMins.push(Math.min(_a.y, _b.y, _c.y));
    }
  });

  const byBatch = new Map();
  for (const [batchId, group] of groups) {
    byBatch.set(batchId, {
      batchId,
      name: group.name,
      detail: group.detail,
      triangles: new Float32Array(group.triangles),
      triangleMins: group.triangleMins,
    });
  }
  return { byBatch };
}

// Cheap pass over cached world triangles: clip to the ring and accumulate into
// one bucket per building. Grouping by building (rather than dumping into one
// array) is what lets the Layers list show only the buildings actually inside
// the outline, and lets a rebuild exclude some without re-downloading anything.
export function clipWorldTriangles(world, subTriangles, ring, out, keyPrefix) {
  for (const group of world.byBatch.values()) {
    const key = `${keyPrefix}#${group.batchId}`;
    const source = group.triangles;
    let bucket = null;

    for (let i = 0, t = 0; i < source.length; i += 9, t++) {
      const clipped = clipTriangleToRing(
        source.subarray(i, i + 9),
        subTriangles,
        ring,
      );
      if (!clipped.length) continue;

      if (!bucket) {
        bucket = out.get(key) ?? {
          key,
          batchId: group.batchId,
          name: group.name,
          detail: group.detail,
          triangles: [],
          triangleMins: [],
        };
        out.set(key, bucket);
      }

      const minY = group.triangleMins[t];
      for (let k = 0; k < clipped.length; k += 9) bucket.triangleMins.push(minY);
      for (let k = 0; k < clipped.length; k++) bucket.triangles.push(clipped[k]);
    }
  }
}

// Flattens the visible buckets into the two parallel arrays the rest of the
// pipeline expects.
export function mergeVisibleBuckets(buckets, isVisible) {
  const triangles = [];
  const triangleMins = [];
  for (const bucket of buckets.values()) {
    if (isVisible && !isVisible(bucket.key)) continue;
    for (let i = 0; i < bucket.triangles.length; i++) {
      triangles.push(bucket.triangles[i]);
    }
    for (const min of bucket.triangleMins) triangleMins.push(min);
  }
  return { triangles, triangleMins };
}

// The Layers list: only buckets that survived clipping, largest first.
export function listLayers(buckets) {
  return [...buckets.values()]
    .filter((bucket) => bucket.triangles.length > 0)
    .sort((a, b) => b.triangles.length - a.triangles.length)
    .map((bucket) => ({
      key: bucket.key,
      batchId: bucket.batchId,
      name: bucket.name,
      detail: bucket.detail,
      triangles: bucket.triangles.length / 9,
    }));
}

export function disposeTileScene(tileScene) {
  tileScene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
  });
}
