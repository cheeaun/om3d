import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

function geometryFromPositions(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildScene({ positions, platePositions }) {
  const scene = new THREE.Scene();
  const material = new THREE.MeshLambertMaterial({ color: 0xfafafa });

  const geometry = geometryFromPositions(positions);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Buildings';
  scene.add(mesh);

  if (platePositions && platePositions.length) {
    const plateGeometry = geometryFromPositions(platePositions);
    const plateMesh = new THREE.Mesh(
      plateGeometry,
      new THREE.MeshLambertMaterial({ color: 0xd8d8d8 }),
    );
    plateMesh.name = 'BasePlate';
    scene.add(plateMesh);
  }

  return scene;
}

export function exportSTL({ positions, platePositions }) {
  const scene = buildScene({ positions, platePositions });
  const exporter = new STLExporter();
  const output = exporter.parse(scene, { binary: true });
  return new Blob([output], { type: 'model/stl' });
}

function gltfExtras(meta) {
  return {
    units: meta.units,
    scale: meta.scale,
    source: 'OneMap 3D',
    centre: meta.centre,
    plate: meta.plate,
  };
}

export async function exportGLTF(
  { positions, platePositions },
  { binary = true, meta },
) {
  const scene = buildScene({ positions, platePositions });
  const exporter = new GLTFExporter();
  const output = await exporter.parseAsync(scene, {
    binary,
    onlyVisible: false,
    trs: true,
  });

  const extras = gltfExtras(meta);

  if (binary) {
    return new Blob([patchGlbExtras(output, extras)], {
      type: 'model/gltf-binary',
    });
  }

  const json = output;
  json.asset = { ...(json.asset ?? {}), extras };
  return new Blob([JSON.stringify(json)], { type: 'model/gltf+json' });
}

const GLB_JSON_CHUNK = 0x4e4f534a;

function patchGlbExtras(buffer, extras) {
  const view = new DataView(buffer);
  const totalLength = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== GLB_JSON_CHUNK) return buffer;

  const jsonBytes = new Uint8Array(buffer, 20, jsonLength);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  json.asset = { ...(json.asset ?? {}), extras };

  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const restLength = totalLength - (20 + jsonLength);
  const newTotal = 20 + paddedLength + restLength;

  const out = new Uint8Array(newTotal);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, view.getUint32(0, true), true);
  outView.setUint32(4, view.getUint32(4, true), true);
  outView.setUint32(8, newTotal, true);
  outView.setUint32(12, paddedLength, true);
  outView.setUint32(16, GLB_JSON_CHUNK, true);
  out.set(encoded, 20);
  out.fill(0x20, 20 + encoded.length, 20 + paddedLength);
  out.set(new Uint8Array(buffer, 20 + jsonLength, restLength), 20 + paddedLength);
  return out;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
