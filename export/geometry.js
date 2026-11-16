import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer/three';

export const CENTER = { lat: 1.285844, lon: 103.857897 };

export function buildFrame() {
  const ellipsoid = WGS84_ELLIPSOID.clone();
  const ecefToWorld = ellipsoid.getObjectFrame(
    THREE.MathUtils.degToRad(CENTER.lat),
    THREE.MathUtils.degToRad(CENTER.lon),
    0,
    0,
    0,
    0,
    new THREE.Matrix4(),
  );
  ecefToWorld.invert();
  return { ellipsoid, ecefToWorld };
}

const _carto = new THREE.Vector3();

export function lonLatToWorld(frame, lon, lat, target = new THREE.Vector3()) {
  frame.ellipsoid.getCartographicToPosition(
    THREE.MathUtils.degToRad(lat),
    THREE.MathUtils.degToRad(lon),
    0,
    _carto,
  );
  return target.copy(_carto).applyMatrix4(frame.ecefToWorld);
}

export function polygonToWorld(frame, polygon) {
  return polygon.map(({ lon, lat }) => {
    const v = lonLatToWorld(frame, lon, lat);
    return { x: v.x, z: v.z };
  });
}

export function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  }
  return area * 0.5;
}

export function ringBounds(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const zi = ring[i].z;
    const xj = ring[j].x;
    const zj = ring[j].z;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function orient2d(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function segmentsIntersect(a, b, c, d) {
  const d1 = orient2d(a, b, c);
  const d2 = orient2d(a, b, d);
  const d3 = orient2d(c, d, a);
  const d4 = orient2d(c, d, b);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

export function isSelfIntersecting(ring) {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

export function triangulateRing(ring) {
  const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const triangles = [];
  for (const face of faces) {
    const tri = face.map((index) => contour[index]);
    triangles.push(toCounterClockwise(tri));
  }
  return triangles;
}

function toCounterClockwise(tri) {
  const [a, b, c] = tri;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return cross < 0 ? [a, c, b] : [a, b, c];
}

const EPS = 1e-9;

function clipPolygonHalfPlane(points, ax, ay, bx, by) {
  if (!points.length) return points;
  const out = [];
  const sideOf = (p) => (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
  let prev = points[points.length - 1];
  let prevSide = sideOf(prev);
  for (const curr of points) {
    const currSide = sideOf(curr);
    const prevIn = prevSide >= -EPS;
    const currIn = currSide >= -EPS;
    if (currIn !== prevIn) {
      const t = prevSide / (prevSide - currSide);
      out.push({
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t,
        y3: prev.y3 + (curr.y3 - prev.y3) * t,
      });
    }
    if (currIn) out.push(curr);
    prev = curr;
    prevSide = currSide;
  }
  return out;
}

const _clipScratch = [];

export function clipTriangleToRing(triWorld, subTriangles, ring) {
  const triangles = [];
  let v0x = triWorld[0];
  let v0y = triWorld[1];
  let v0z = triWorld[2];
  let v1x = triWorld[3];
  let v1y = triWorld[4];
  let v1z = triWorld[5];
  let v2x = triWorld[6];
  let v2y = triWorld[7];
  let v2z = triWorld[8];

  // Fast path: a triangle wholly inside the ring needs no clipping. This is the
  // overwhelmingly common case and it matters because clipping against the
  // ring's convex pieces also splits triangles on the triangulation's *interior*
  // diagonals, which would needlessly multiply the triangle count.
  if (
    ring &&
    pointInRing(v0x, v0z, ring) &&
    pointInRing(v1x, v1z, ring) &&
    pointInRing(v2x, v2z, ring)
  ) {
    return [v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z];
  }

  const triMinX = Math.min(v0x, v1x, v2x);
  const triMaxX = Math.max(v0x, v1x, v2x);
  const triMinZ = Math.min(v0z, v1z, v2z);
  const triMaxZ = Math.max(v0z, v1z, v2z);

  for (const sub of subTriangles) {
    if (sub.maxX < triMinX || sub.minX > triMaxX) continue;
    if (sub.maxZ < triMinZ || sub.minZ > triMaxZ) continue;

    _clipScratch.length = 0;
    _clipScratch.push(
      { x: v0x, y: v0z, y3: v0y },
      { x: v1x, y: v1z, y3: v1y },
      { x: v2x, y: v2z, y3: v2y },
    );

    let clipped = _clipScratch;
    const [a, b, c] = sub.points;
    clipped = clipPolygonHalfPlane(clipped, a.x, a.y, b.x, b.y);
    clipped = clipPolygonHalfPlane(clipped, b.x, b.y, c.x, c.y);
    clipped = clipPolygonHalfPlane(clipped, c.x, c.y, a.x, a.y);

    if (clipped.length < 3) continue;

    for (let i = 1; i < clipped.length - 1; i++) {
      const p = clipped[0];
      const q = clipped[i];
      const r = clipped[i + 1];
      const area =
        (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      if (Math.abs(area) < EPS) continue;
      triangles.push(
        p.x, p.y3, p.y,
        q.x, q.y3, q.y,
        r.x, r.y3, r.y,
      );
    }
  }
  return triangles;
}

// Ground height for the plate. Each *building's* base is one sample, not each
// triangle: a tall building is subdivided into many wall triangles whose min-Y
// spreads over the whole height, so a per-triangle histogram is dominated by
// whatever storeys have the most subdivisions and the mode can land tens of
// metres up the side of a tower. That error is what made the slab cut through
// buildings. Pass one entry per building (`Math.min` of its triangle mins).
export function computeGroundY(buildingBases, bin = 1) {
  if (!buildingBases.length) return 0;
  const counts = new Map();
  let bestBin = null;
  let bestCount = 0;
  for (const y of buildingBases) {
    const key = Math.round(y / bin);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > bestCount) {
      bestCount = count;
      bestBin = key;
    }
  }
  let sum = 0;
  let n = 0;
  for (const y of buildingBases) {
    if (Math.round(y / bin) === bestBin) {
      sum += y;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Reduces per-triangle minimum heights to one base per building. The plate must
// sit at the modal building base, and buildings on higher ground need the slab
// top high enough that their bases are buried rather than floating.
export function buildingBasesFromBuckets(buckets) {
  const bases = [];
  for (const bucket of buckets.values()) {
    if (!bucket.triangleMins?.length) continue;
    let min = Infinity;
    for (const y of bucket.triangleMins) {
      if (y < min) min = y;
    }
    if (Number.isFinite(min)) bases.push(min);
  }
  return bases;
}

export function buildBasePlate(ring, topY, thickness, margin = 0) {
  const points = margin > 0 ? offsetRing(ring, margin) : ring;
  const shape = new THREE.Shape();
  shape.moveTo(points[0].x, -points[0].z);
  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i].x, -points[i].z);
  }
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, topY - thickness, 0);

  const position = geometry.getAttribute('position');
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  geometry.dispose();
  return positions;
}

function offsetRing(ring, distance) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    const e0 = normalize(curr.x - prev.x, curr.z - prev.z);
    const e1 = normalize(next.x - curr.x, next.z - curr.z);
    const n0 = { x: -e0.z, z: e0.x };
    const n1 = { x: -e1.z, z: e1.x };
    let bx = n0.x + n1.x;
    let bz = n0.z + n1.z;
    const len = Math.hypot(bx, bz);
    if (len < EPS) {
      bx = n1.x;
      bz = n1.z;
    } else {
      bx /= len;
      bz /= len;
    }
    const scale = distance / Math.max(0.2, bx * n1.x + bz * n1.z);
    out.push({ x: curr.x + bx * scale, z: curr.z + bz * scale });
  }
  return out;
}

function normalize(x, z) {
  const len = Math.hypot(x, z);
  if (len < EPS) return { x: 0, z: 0 };
  return { x: x / len, z: z / len };
}

export function boundsOf(positions) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export function measureBounds(positions, ring) {
  const bounds = boundsOf(positions);
  let { minX, maxX, minZ, maxZ, minY, maxY } = bounds;
  if (ring) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    extentX: maxX - minX,
    extentZ: maxZ - minZ,
    extentY: maxY - minY,
    footprint: Math.max(maxX - minX, maxZ - minZ),
  };
}

export function fitScaleFor(footprintMetres, targetMM) {
  if (!(footprintMetres > 0)) return 1;
  return targetMM / footprintMetres;
}

export function applyScale(positions, scale, bounds) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = (positions[i] - cx) * scale;
    out[i + 1] = (positions[i + 1] - bounds.minY) * scale;
    out[i + 2] = (positions[i + 2] - cz) * scale;
  }
  return out;
}

// The same transform as `applyScale`, for a single point. Used to place the drawn
// outline on the preview's ground plane so it lines up with the exported geometry.
export function projectPoint(x, y, z, scale, bounds) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  return {
    x: (x - cx) * scale,
    y: (y - bounds.minY) * scale,
    z: (z - cz) * scale,
  };
}

export function concatPositions(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
