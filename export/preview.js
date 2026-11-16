import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Preview colour schemes. Every one pairs a background with a model colour that
// differs strongly in luminance, because the previous white-on-white default made
// the silhouette impossible to read.
export const SCHEMES = {
  slate: {
    label: 'Slate',
    background: 0x2c3136,
    exposure: 1.15,
    hemi: { sky: 0xffffff, ground: 0x3a4046, intensity: 1.5 },
    key: { color: 0xffffff, intensity: 3.4, position: [1, 1.6, 0.8] },
    fill: { color: 0xb9d0e4, intensity: 0.9, position: [-1, 0.5, -0.8] },
    building: 0xeceae3,
    plate: 0x8e8a82,
  },
  iridescent: {
    label: 'Iridescent',
    background: 0x14161b,
    exposure: 1.12,
    hemi: { sky: 0xd8e4ff, ground: 0x1a1d24, intensity: 1.2 },
    key: { color: 0xffffff, intensity: 3.2, position: [1, 1.6, 0.8] },
    fill: { color: 0x9fe8ff, intensity: 1.0, position: [-1, 0.5, -0.8] },
    building: 0xffffff,
    // The slab is the model's only reference plane, so it has to read clearly
    // against the near-black background; a darker grey vanishes into it and the
    // buildings look like they float.
    plate: 0x6f7681,
    iridescent: true,
  },
};

export const DEFAULT_SCHEME = 'iridescent';

export function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 2, 4000000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxDistance = 4000000;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x3a4046, 1.5);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.position.set(1, 1.6, 0.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb9d0e4, 0.9);
  fill.position.set(-1, 0.5, -0.8);
  scene.add(fill);

  const group = new THREE.Group();
  scene.add(group);

  let buildingMeshes = [];
  let plateMeshes = [];
  let outlineObjects = [];
  // Line2 needs its material resolution kept in sync with the canvas, separate
  // from the plain meshes above.
  let outlineLines = [];
  // The annotation objects are kept apart so they can be hidden without
  // rebuilding the model.
  let annotationObjects = [];
  let scheme = SCHEMES[DEFAULT_SCHEME];
  let needsRender = true;
  let wireframe = false;
  let annotationsVisible = true;
  let framedOnce = false;

  // `controls.update()` returns true while OrbitControls' damping is still
  // settling, so keep rendering until it stops. Rendering only on `needsRender`
  // would cut the inertia short and make the orbit feel stuck.
  function render() {
    const settled = !controls.update();
    if (needsRender || !settled) {
      resize();
      renderer.render(scene, camera);
      needsRender = false;
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const line of outlineLines) {
      line.material.resolution.set(width, height);
    }
  }

  function disposeMeshes() {
    const geometries = new Set();
    const materials = new Set();
    for (const object of [...buildingMeshes, ...plateMeshes, ...outlineObjects]) {
      group.remove(object);
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    }
    // Outline dots share one geometry and one material, so dispose each once.
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) {
      // Sprite labels own a canvas texture that the material disposal misses.
      material.map?.dispose();
      material.dispose();
    }
    buildingMeshes = [];
    plateMeshes = [];
    outlineObjects = [];
    outlineLines = [];
    annotationObjects = [];
    // The render loop is demand-driven, so without this the canvas keeps showing
    // the last frame even though every mesh has been removed.
    needsRender = true;
  }

  function addMesh(positions) {
    if (!positions?.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const material = new THREE.MeshLambertMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    return mesh;
  }

  function applyScheme() {
    scene.background = new THREE.Color(scheme.background);
    renderer.toneMappingExposure = scheme.exposure;

    hemi.color.setHex(scheme.hemi.sky);
    hemi.groundColor.setHex(scheme.hemi.ground);
    hemi.intensity = scheme.hemi.intensity;

    key.color.setHex(scheme.key.color);
    key.intensity = scheme.key.intensity;
    key.position.fromArray(scheme.key.position);

    fill.color.setHex(scheme.fill.color);
    fill.intensity = scheme.fill.intensity;
    fill.position.fromArray(scheme.fill.position);

    for (const mesh of buildingMeshes) {
      mesh.material.color.setHex(scheme.building);
      mesh.material.wireframe = wireframe;
      mesh.material.vertexColors = Boolean(scheme.iridescent) && !wireframe;
      mesh.material.needsUpdate = true;
    }
    for (const mesh of plateMeshes) {
      mesh.material.color.setHex(scheme.plate);
      mesh.material.wireframe = wireframe;
      mesh.material.vertexColors = false;
      mesh.material.needsUpdate = true;
    }

    needsRender = true;
  }

  // Iridescence without a custom shader: colour each triangle by its face
  // normal, so facets pick up different hues and the model shimmers as it
  // rotates. Non-indexed geometry gives one normal per triangle, which is what
  // makes the facets distinct instead of a smooth gradient.
  function addIridescentColors(mesh) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const colors = new Float32Array(position.count * 3);
    const color = new THREE.Color();

    for (let i = 0; i < position.count; i += 3) {
      // Average the three vertex normals so a facet has one hue.
      const nx = (normal.getX(i) + normal.getX(i + 1) + normal.getX(i + 2)) / 3;
      const ny = (normal.getY(i) + normal.getY(i + 1) + normal.getY(i + 2)) / 3;
      const nz = (normal.getZ(i) + normal.getZ(i + 1) + normal.getZ(i + 2)) / 3;

      const azimuth = Math.atan2(nz, nx) / (Math.PI * 2) + 0.5;
      const tilt = Math.acos(Math.min(1, Math.max(-1, ny))) / Math.PI;
      const hue = (azimuth * 0.85 + tilt * 0.45) % 1;
      color.setHSL(hue, 0.62, 0.6 + tilt * 0.16);

      for (let v = 0; v < 3; v++) {
        colors[(i + v) * 3] = color.r;
        colors[(i + v) * 3 + 1] = color.g;
        colors[(i + v) * 3 + 2] = color.b;
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  function sceneBounds() {
    const box = new THREE.Box3();
    for (const mesh of [...buildingMeshes, ...plateMeshes]) {
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
    }
    for (const object of outlineObjects) {
      if (object.position) box.expandByPoint(object.position);
      if (object.geometry?.boundingBox) box.union(object.geometry.boundingBox);
    }
    return box;
  }

  // Only runs on the first build, or when the caller explicitly asks. Re-framing
  // on every live rebuild would yank the camera back while the user is orbiting.
  function frame() {
    const box = sceneBounds();
    for (const mesh of [...buildingMeshes, ...plateMeshes]) {
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
    }
    // The outline can extend past the plate, so include its points explicitly.
    for (const object of outlineObjects) {
      box.expandByPoint(object.position);
      if (object.geometry?.boundingBox) {
        box.union(object.geometry.boundingBox);
      }
    }
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance =
      (maxSize / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.9;

    camera.position.set(
      center.x + distance * 0.55,
      center.y + distance * 0.75,
      center.z + distance * 0.55,
    );
    camera.near = Math.max(0.01, distance / 500);
    camera.far = distance * 40;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    needsRender = true;
  }

  function show({ buildings, plate, outline }, { refit = false } = {}) {
    disposeMeshes();

    const buildingMesh = addMesh(buildings);
    if (buildingMesh) {
      addIridescentColors(buildingMesh);
      buildingMeshes = [buildingMesh];
    }

    const plateMesh = addMesh(plate);
    if (plateMesh) plateMeshes = [plateMesh];

    showOutline(outline);
    applyScheme();
    if (!framedOnce || refit) {
      frame();
      framedOnce = true;
    } else {
      // Keep the camera untouched. Recomputing the clip planes here would look
      // like a small jump, and it is unnecessary: the camera has not moved, so
      // the planes framed for this distance are still correct.
      needsRender = true;
    }
  }

  function fitClipPlanes() {
    const controlsTarget = controls.target;
    const distance = camera.position.distanceTo(controlsTarget);
    camera.near = Math.max(0.01, distance / 500);
    camera.far = Math.max(distance * 40, 10);
    camera.updateProjectionMatrix();
  }

  // The drawn polygon, laid on the ground plane and drawn semi-transparently so
  // it does not compete with the model. It answers "which exact area did I pick",
  // which the geometry alone cannot show once buildings are clipped at the edge.
  function showOutline(outline) {
    if (!outline || outline.points.length < 3) return;

    const points = outline.points;
    const y = outline.y;

    // A faint wash so the selected region reads at a glance, but weak enough that
    // the buildings on top stay the subject.
    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, -points[0].z);
    for (let i = 1; i < points.length; i++) {
      shape.lineTo(points[i].x, -points[i].z);
    }
    shape.closePath();

    const fillGeometry = new THREE.ShapeGeometry(shape);
    fillGeometry.rotateX(-Math.PI / 2);
    fillGeometry.translate(0, y, 0);
    const fill = new THREE.Mesh(
      fillGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xff6b5a,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    fill.renderOrder = 2;
    group.add(fill);
    outlineObjects.push(fill);
    annotationObjects.push(fill);

    // Real world-space widths: a plain THREE.Line is 1 device pixel regardless of
    // camera distance, which disappears next to a 150 mm model.
    const positions = [];
    for (const point of points) positions.push(point.x, y, point.z);
    positions.push(points[0].x, y, points[0].z);
    const lineGeometry = new LineGeometry();
    lineGeometry.setPositions(positions);
    const lineMaterial = new LineMaterial({
      color: 0xff3b30,
      linewidth: 2.5,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      dashed: true,
      dashSize: outline.dashSize,
      gapSize: outline.dashSize * 0.6,
    });
    lineMaterial.resolution.set(canvas.clientWidth, canvas.clientHeight);
    const line = new Line2(lineGeometry, lineMaterial);
    line.computeLineDistances();
    line.renderOrder = 3;
    group.add(line);
    outlineObjects.push(line);
    annotationObjects.push(line);
    outlineLines.push(line);

    // Corner dots, so the drawn vertices are identifiable in 3D.
    const dotGeometry = new THREE.SphereGeometry(outline.dotRadius, 12, 9);
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3b30,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    for (const [index, point] of points.entries()) {
      const dot = new THREE.Mesh(dotGeometry, dotMaterial);
      dot.position.set(point.x, y, point.z);
      dot.renderOrder = 4;
      group.add(dot);
      outlineObjects.push(dot);
      annotationObjects.push(dot);

      // Numbered badge, matching the A/B/C… order of the handles on the map.
      const label = makeLabelSprite(index + 1, outline.labelSize);
      label.position.set(
        point.x,
        y + outline.dotRadius * 1.6 + outline.labelSize * 0.75,
        point.z,
      );
      label.renderOrder = 5;
      group.add(label);
      outlineObjects.push(label);
      annotationObjects.push(label);
    }
  }

  // A camera-facing number badge. Sprites always face the viewer, so the label
  // stays readable from any orbit angle, unlike a plane mesh.
  function makeLabelSprite(number, size) {
    const texture = makeLabelTexture(String(number));
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(size, size, 1);
    return sprite;
  }

  function makeLabelTexture(text) {
    const pixels = 128;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = pixels;
    canvasEl.height = pixels;
    const ctx = canvasEl.getContext('2d');

    ctx.beginPath();
    ctx.arc(pixels / 2, pixels / 2, pixels / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(pixels * 0.52)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pixels / 2, pixels / 2 + pixels * 0.03);

    const texture = new THREE.CanvasTexture(canvasEl);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  function applyAnnotationVisibility() {
    for (const object of annotationObjects) {
      object.visible = annotationsVisible;
    }
    needsRender = true;
  }

  return {
    show,
    clear: disposeMeshes,
    // Test hook: lets a smoke test assert that a rebuild did not move the view.
    getCameraState: () => ({
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      zoom: camera.zoom,
    }),
    setAnnotationsVisible(visible) {
      annotationsVisible = Boolean(visible);
      applyAnnotationVisibility();
    },
    getAnnotationsVisible: () => annotationsVisible,
    refit() {
      frame();
      needsRender = true;
    },
    zoomBy(factor) {
      // OrbitControls zooms by moving the camera along the view ray, so scaling
      // its distance is the same operation a wheel/pinch performs.
      const offset = camera.position.clone().sub(controls.target);
      const next = THREE.MathUtils.clamp(
        offset.length() / factor,
        controls.minDistance,
        controls.maxDistance,
      );
      offset.setLength(next);
      camera.position.copy(controls.target).add(offset);
      fitClipPlanes();
      controls.update();
      needsRender = true;
    },
    setScheme(name) {
      const next = SCHEMES[name];
      if (!next) return;
      scheme = next;
      applyScheme();
    },
    setWireframe(enabled) {
      wireframe = Boolean(enabled);
      applyScheme();
    },
    getScheme: () => scheme,
    resize: () => {
      needsRender = true;
    },
    dispose() {
      disposeMeshes();
      controls.dispose();
      renderer.dispose();
    },
  };
}
