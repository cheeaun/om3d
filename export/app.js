import {
  applyScale,
  buildBasePlate,
  buildFrame,
  buildingBasesFromBuckets,
  computeGroundY,
  concatPositions,
  fitScaleFor,
  isSelfIntersecting,
  measureBounds,
  polygonToWorld,
  projectPoint,
  ringArea,
} from './geometry.js';
import {
  clipWorldTriangles,
  createDecoder,
  disposeTileScene,
  extractWorldTriangles,
  listLayers,
  mergeVisibleBuckets,
  prepareClipGeometry,
  selectTiles,
} from './tiles.js';
import { download, exportGLTF, exportSTL } from './formats.js';
import { createMap } from './map.js';
import { SCHEMES, DEFAULT_SCHEME, createPreview } from './preview.js';

// Resolved against the page, not the module, so it stays on the deployed
// `optimized-tiles/` directory instead of becoming a bundled asset. Using
// `import.meta.url` here would make Vite copy the tileset into `dist/assets/`
// and every tile URI would then resolve next to it, where no .b3dm exists.
const TILESET_BASE = new URL('../optimized-tiles/', document.baseURI);
const TILESET_URL = new URL('tileset.json', TILESET_BASE);
const MAX_BUILDINGS = 4000;

const SETTINGS_KEY = 'om3d.export.settings';

// Everything that shapes the export and is worth restoring across reloads. The
// area polygon has its own key in map.js; this covers the model and view options.
const SETTING_DEFAULTS = {
  sizeMM: 150,
  plateEnabled: true,
  thicknessMM: 2,
  marginMM: 0,
  format: 'stl',
  scaleMode: 'fit',
  scheme: DEFAULT_SCHEME,
  wireframe: false,
  annotations: true,
  hiddenLayers: [],
};

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    // Only take keys we know, so a stale field cannot corrupt the state.
    for (const [key, fallback] of Object.entries(SETTING_DEFAULTS)) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (typeof fallback === 'number') {
        if (Number.isFinite(value)) out[key] = value;
      } else if (typeof fallback === 'boolean') {
        if (typeof value === 'boolean') out[key] = value;
      } else if (Array.isArray(fallback)) {
        if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === 'string');
      } else if (typeof value === 'string') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        sizeMM: state.sizeMM,
        plateEnabled: state.plateEnabled,
        thicknessMM: state.thicknessMM,
        marginMM: state.marginMM,
        format: state.format,
        scaleMode: state.scaleMode,
        scheme: state.scheme,
        wireframe: state.wireframe,
        annotations: state.annotations,
        hiddenLayers: [...state.hiddenLayers],
      }),
    );
  } catch {
    // Storage can be unavailable in private mode; the page still works.
  }
}

const savedSettings = readSettings();
const state = {
  polygon: [],
  sizeMM: savedSettings.sizeMM ?? 150,
  plateEnabled: savedSettings.plateEnabled ?? true,
  thicknessMM: savedSettings.thicknessMM ?? 2,
  marginMM: savedSettings.marginMM ?? 0,
  format: savedSettings.format ?? 'stl',
  scaleMode: savedSettings.scaleMode ?? 'fit',
  scheme: savedSettings.scheme ?? DEFAULT_SCHEME,
  wireframe: savedSettings.wireframe ?? false,
  annotations: savedSettings.annotations ?? true,
  // Layers are keyed by `<tileUri>#<batchId>`; the merged set is restored here
  // and re-seeded per build from whatever the outline actually covers.
  hiddenLayers: new Set(savedSettings.hiddenLayers ?? []),
  buckets: new Map(),
  layers: [],
  building: false,
  preview: null,
  abort: null,
};

const els = {
  status: document.getElementById('status'),
  sizeCustom: document.getElementById('size-custom'),
  plate: document.getElementById('plate'),
  plateNote: document.getElementById('plate-note'),
  thickness: document.getElementById('thickness'),
  thicknessValue: document.getElementById('thickness-value'),
  margin: document.getElementById('margin'),
  marginValue: document.getElementById('margin-value'),
  scaleModes: document.getElementById('scale-modes'),
  build: document.getElementById('build'),
  download: document.getElementById('download'),
  cancel: document.getElementById('cancel'),
  undo: document.getElementById('undo'),
  clear: document.getElementById('clear'),
  reset: document.getElementById('reset'),
  panel: document.getElementById('panel'),
  plateOptions: document.getElementById('plate-options'),
  layersGroup: document.getElementById('layers-group'),
  layersList: document.getElementById('layers-list'),
  layersCount: document.getElementById('layers-count'),
  panelToggle: document.getElementById('panel-toggle'),
  workspace: document.getElementById('workspace'),
  previewCanvas: document.getElementById('preview-canvas'),
  previewCaption: document.getElementById('preview-caption'),
  previewEmpty: document.getElementById('preview-empty'),
  previewClose: document.getElementById('preview-close'),
  wireframe: document.getElementById('wireframe'),
  annotations: document.getElementById('annotations'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  refit: document.getElementById('refit'),
  sizeButtons: Array.from(document.querySelectorAll('[data-size]')),
  formatButtons: Array.from(document.querySelectorAll('[data-format]')),
  scaleButtons: Array.from(document.querySelectorAll('[data-scale]')),
  schemeButtons: Array.from(document.querySelectorAll('[data-scheme]')),
};

const frame = buildFrame();
const mapApi = createMap({ onPolygonChange });

function setStatus(text, tone = 'info') {
  if (!els.status) return;
  els.status.textContent = text ?? '';
  els.status.dataset.tone = tone;
}

function ringWorld() {
  return polygonToWorld(frame, state.polygon);
}

// Live preview: every option and outline change schedules a debounced rebuild,
// which is cheap after the first run because decoded tiles stay cached.
const LIVE_DEBOUNCE_MS = 350;
let liveTimer = null;

function scheduleLiveBuild() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveTimer = null;
    if (polygonProblem()) return;
    buildPreview({ live: true });
  }, LIVE_DEBOUNCE_MS);
}

function onPolygonChange(polygon) {
  const changed =
    polygon.length !== state.polygon.length ||
    polygon.some(
      (p, i) =>
        p.lat !== state.polygon[i]?.lat || p.lon !== state.polygon[i]?.lon,
    );
  state.polygon = polygon;
  if (!changed) return;
  els.download.textContent = 'Download';

  // Fewer than 3 vertices cannot form an area, so a build would bail out early
  // and leave the previous model on screen. Clear the preview instead, otherwise
  // pressing Clear looks like it did nothing.
  if (polygonProblem()) {
    clearPreviewPane();
    updateButtons();
    return;
  }

  updateButtons();
  scheduleLiveBuild();
}

// Options that change the model (rather than just how it is drawn) rebuild live
// too. Camera and colour-scheme changes deliberately do not, so orbiting the
// preview is never interrupted by a rebuild.
function invalidatePreview() {
  els.download.textContent = 'Download';
  scheduleLiveBuild();
}

function polygonProblem() {
  if (state.polygon.length < 3) return 'Add at least 3 vertices.';
  const ring = ringWorld();
  if (Math.abs(ringArea(ring)) < 1) return 'The area is too small.';
  if (isSelfIntersecting(ring)) return 'The outline crosses itself.';
  return null;
}

function updateButtons() {
  const problem = polygonProblem();
  els.build.disabled = Boolean(problem) || state.building;
  els.download.disabled = !state.preview || state.building;
  if (problem) setStatus(problem, 'error');
}

function syncSizeButtons() {
  for (const button of els.sizeButtons) {
    button.setAttribute(
      'aria-checked',
      String(Number(button.dataset.size) === state.sizeMM),
    );
  }
  els.sizeCustom.value = String(state.sizeMM);
  writeSettings();
}

function syncFormatButtons() {
  for (const button of els.formatButtons) {
    button.setAttribute(
      'aria-checked',
      String(button.dataset.format === state.format),
    );
  }
  for (const button of els.scaleButtons) {
    button.setAttribute(
      'aria-checked',
      String(button.dataset.scale === state.scaleMode),
    );
  }
  if (els.scaleModes) {
    els.scaleModes.hidden = state.format === 'stl';
  }
  writeSettings();
}

function syncSchemeButtons() {
  for (const button of els.schemeButtons) {
    button.setAttribute(
      'aria-checked',
      String(button.dataset.scheme === state.scheme),
    );
  }
  writeSettings();
}

function isLayerVisible(key) {
  return !state.hiddenLayers.has(key);
}

function renderLayers() {
  const layers = state.layers ?? [];
  els.layersGroup.hidden = layers.length === 0;
  const list = els.layersList;
  list.textContent = '';

  for (const layer of layers) {
    const row = document.createElement('label');
    row.className = 'layer';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = isLayerVisible(layer.key);
    input.addEventListener('change', () => {
      // Enforce at least one visible building: unticking the last visible one is
      // refused, so the export always has geometry.
      if (!input.checked && visibleLayerCount() <= 1) {
        input.checked = true;
        return;
      }
      if (input.checked) state.hiddenLayers.delete(layer.key);
      else state.hiddenLayers.add(layer.key);
      writeSettings();
      scheduleLiveBuild();
    });

    const swatch = document.createElement('span');
    swatch.className = 'layer-swatch';

    const text = document.createElement('span');
    text.className = 'layer-text';

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;

    const detail = document.createElement('span');
    detail.className = 'layer-detail';
    detail.textContent = layer.detail || `${layer.triangles.toLocaleString()} triangles`;

    text.append(name, detail);
    row.append(input, swatch, text);
    list.append(row);
  }

  els.layersCount.textContent = layers.length
    ? `${visibleLayerCount()} of ${layers.length} shown`
    : '';
}

function visibleLayerCount() {
  return (state.layers ?? []).filter((layer) => isLayerVisible(layer.key)).length;
}

function syncPlate() {
  els.plate.setAttribute('aria-pressed', String(state.plateEnabled));
  // With no plate, thickness and margin have nothing to act on, so hide them
  // rather than leave dead controls.
  els.plateOptions.hidden = !state.plateEnabled;
  els.plateNote.hidden = state.plateEnabled;
  // Push state back into the sliders too, not just their labels: on load the
  // sliders are still at their HTML defaults while the state came from storage.
  if (Number(els.thickness.value) !== state.thicknessMM) {
    els.thickness.value = String(state.thicknessMM);
  }
  if (Number(els.margin.value) !== state.marginMM) {
    els.margin.value = String(state.marginMM);
  }
  els.thicknessValue.textContent = `${state.thicknessMM.toFixed(1)} mm`;
  els.marginValue.textContent = `${state.marginMM} mm`;
  writeSettings();
}

// Decoded tile geometry, keyed by URI. Extracting world triangles out of a tile
// is the expensive half (fetch + meshopt decode + matrix transform); clipping
// them to the drawn ring is cheap. Caching lets a dragged vertex rebuild the
// preview live without re-downloading anything.
const tileCache = new Map();

function clearTileCache() {
  tileCache.clear();
}

async function loadTileWorld(uri, loader, signal) {
  const cached = tileCache.get(uri);
  if (cached) return cached;
  const url = new URL(uri, TILESET_BASE);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const model = await loader.parse(buffer);
  const world = extractWorldTriangles(model.scene, frame.ecefToWorld);
  disposeTileScene(model.scene);
  tileCache.set(uri, world);
  return world;
}

let buildToken = 0;

async function buildPreview({ live = false } = {}) {
  const problem = polygonProblem();
  if (problem) {
    setStatus(problem, 'error');
    return;
  }

  // A manual build is the user asking to see the result, so bring the overlay up
  // on narrow screens. Live rebuilds leave it alone: it is already open if they
  // can see it, and popping it open while dragging handles would be intrusive.
  if (!live) openPreview();

  // A live rebuild can be superseded by the next one; the token makes stale runs
  // bail out instead of painting over newer results.
  const token = ++buildToken;
  state.building = true;
  els.build.disabled = true;
  els.download.disabled = true;
  els.build.textContent = live ? 'Live…' : 'Building…';
  els.cancel.hidden = live;
  state.abort?.abort();
  const controller = new AbortController();
  state.abort = controller;

  let outcome = null;
  try {
    setStatus('Loading tileset…');
    const root = await loadTileset(controller.signal);
    if (token !== buildToken) return;

    const ring = ringWorld();
    const tiles = selectTiles(root, frame, ring);
    if (!tiles.length) {
      outcome = {
        text: 'Nothing to export here — try an area with buildings.',
        tone: 'error',
      };
      return;
    }

    const subTriangles = prepareClipGeometry(ring);
    const loader = createDecoder();
    const buckets = new Map();

    let done = 0;
    let failed = 0;
    for (const tile of tiles) {
      if (controller.signal.aborted || token !== buildToken) {
        throw new DOMException('Aborted', 'AbortError');
      }
      try {
        const world = await loadTileWorld(tile.uri, loader, controller.signal);
        clipWorldTriangles(world, subTriangles, ring, buckets, tile.uri);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        failed++;
      }
      done++;
      setStatus(`Loading tiles ${done}/${tiles.length}…`);
      if (buckets.size > MAX_BUILDINGS) {
        throw new Error(
          'This area covers too many buildings. Try a smaller rectangle.',
        );
      }
    }
    if (token !== buildToken) return;

    state.buckets = buckets;
    const layers = listLayers(buckets);
    state.layers = layers;
    // Keep the user's ticks for buildings that are still in the outline, and
    // default any newly-revealed building to visible.
    const keys = new Set(layers.map((layer) => layer.key));
    state.hiddenLayers = new Set(
      [...state.hiddenLayers].filter((key) => keys.has(key)),
    );
    // Never leave everything hidden, or there would be nothing to export.
    if (layers.length && state.hiddenLayers.size >= layers.length) {
      state.hiddenLayers.delete(layers[0].key);
    }
    renderLayers();

    const clipped = mergeVisibleBuckets(buckets, isLayerVisible);
    if (!clipped.triangles.length) {
      outcome = {
        text: layers.length
          ? 'All buildings are unticked — enable one to export.'
          : 'No building geometry inside that area.',
        tone: 'error',
      };
      return;
    }

    const raw = new Float32Array(clipped.triangles);
    // One sample per *building*, not per triangle: see `computeGroundY`.
    const visibleBuckets = new Map(
      [...buckets].filter(([key]) => isLayerVisible(key)),
    );
    const groundY = computeGroundY(buildingBasesFromBuckets(visibleBuckets));

    // One scale drives everything, so a fitted model always fills `sizeMM` on its
    // longest side. The footprint is buildings ∪ drawn area, because the plate
    // takes the drawn outline.
    //
    // Two different factors are involved and must not be confused:
    // - `mmPerMetre` is the fit scale (meaningless in real-world 1:1, so it is
    //   still computed for the plate conversion below).
    // - `unitPerMetre` is what output coordinates are expressed in: mm when
    //   fitting to a size, raw metres for real-world 1:1.
    // The plate thickness is authored in millimetres, so it converts to world
    // metres with `mmPerMetre`, independent of the output units. Using
    // `unitPerMetre` here made a 2 mm plate 2 metres thick in 1:1 mode.
    const realScale = state.format !== 'stl' && state.scaleMode === 'real';
    const measured = measureBounds(raw, ring);
    const mmPerMetre = fitScaleFor(measured.footprint, state.sizeMM);
    const unitPerMetre = realScale ? 1 : mmPerMetre;

    const plateWorld =
      state.plateEnabled && ring.length >= 3
        ? buildBasePlate(
            ring,
            groundY,
            state.thicknessMM / mmPerMetre,
            state.marginMM / mmPerMetre,
          )
        : null;

    const combinedWorld = plateWorld ? concatPositions([raw, plateWorld]) : raw;
    const worldBounds = measureBounds(combinedWorld);
    const output = applyScale(combinedWorld, unitPerMetre, worldBounds);

    const buildingsLength = raw.length;

    // Place the drawn outline on the plate's top surface so it reads as "the
    // area I picked" instead of floating. `groundY` is the modal building base,
    // which is where the plate top sits; `worldBounds.minY` is the bed.
    const outlineY = (groundY - worldBounds.minY) * unitPerMetre;
    const outlinePoints = ring.map((p) => {
      const projected = projectPoint(p.x, groundY, p.z, unitPerMetre, worldBounds);
      return { x: projected.x, z: projected.z };
    });
    const diagonal = Math.hypot(worldBounds.extentX, worldBounds.extentZ) * unitPerMetre;
    const outline = {
      points: outlinePoints,
      y: outlineY,
      dotRadius: Math.max(0.4, diagonal * 0.004),
      dashSize: Math.max(0.6, diagonal * 0.02),
      labelSize: diagonal * 0.05,
    };

    const fitted = {
      positions: output,
      unitPerMetre,
      units: realScale ? 'm' : 'mm',
      ratio: realScale ? 1 : 1000 / unitPerMetre,
      bounds: {
        width: worldBounds.extentX * unitPerMetre,
        depth: worldBounds.extentZ * unitPerMetre,
        height: worldBounds.extentY * unitPerMetre,
      },
    };

    state.preview = {
      buildings: output.slice(0, buildingsLength),
      plate: plateWorld ? output.slice(buildingsLength) : null,
      outline,
      fitted,
      triangleCount: output.length / 9,
      tilesTotal: tiles.length,
      tilesFailed: failed,
    };

    setStatus(
      `Ready · ${(output.length / 9).toLocaleString()} triangles` +
        (failed ? ` · ${failed}/${tiles.length} tiles failed` : ''),
    );
    showPreview();
  } catch (error) {
    if (error.name === 'AbortError' && token !== buildToken) return;
    const aborted = error.name === 'AbortError';
    outcome = {
      text: aborted ? 'Cancelled.' : error.message ?? String(error),
      tone: aborted ? 'info' : 'error',
    };
  } finally {
    if (token === buildToken) {
      state.building = false;
      state.abort = null;
      els.build.textContent = 'Build preview';
      els.cancel.hidden = true;
      updateButtons();
      // updateButtons() writes the default hint when there is no preview, which
      // would otherwise overwrite the message this run produced.
      if (outcome) setStatus(outcome.text, outcome.tone);
    }
  }
}

let tilesetPromise = null;
async function loadTileset(signal) {
  if (!tilesetPromise) {
    // Never cache a failed or aborted request: it would reject every later build.
    tilesetPromise = fetch(TILESET_URL, { signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Tileset ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        tilesetPromise = null;
        throw error;
      });
  }
  const root = await tilesetPromise;
  return root.root ?? root;
}

let previewApi = null;
// Exposed for smoke tests: verifies that a live rebuild preserves the view.
window.__previewState = () => previewApi?.getCameraState();

function showPreview() {
  if (!previewApi) previewApi = createPreview(els.previewCanvas);
  previewApi.show(state.preview, { refit: !state.hasBuilt });
  state.hasBuilt = true;
  previewApi.setScheme(state.scheme);
  previewApi.setWireframe(state.wireframe);
  previewApi.setAnnotationsVisible(state.annotations);
  syncSchemeButtons();
  els.previewEmpty.hidden = true;
  const { bounds, ratio, units } = state.preview.fitted;
  els.previewCaption.textContent =
    `${bounds.width.toFixed(1)} × ` +
    `${bounds.depth.toFixed(1)} × ${bounds.height.toFixed(1)} ${units} · ` +
    `${state.preview.triangleCount.toLocaleString()} triangles · ` +
    (units === 'mm'
      ? `1:${Math.round(ratio).toLocaleString()} · `
      : 'real-world 1:1 · ') +
    (state.preview.plate
      ? `base plate ${state.thicknessMM.toFixed(1)} mm`
      : 'no base plate');
}

// Below the split-view breakpoint the preview is a full-screen overlay rather than
// a pane, so it has to be opened explicitly. `Build preview` does that itself
// instead of exposing a second "View 3D" button: on a narrow screen, building into
// an invisible pane and then pressing another button is one step too many.
const WIDE_LAYOUT = window.matchMedia('(min-width: 900px)');

function openPreview() {
  if (WIDE_LAYOUT.matches) return;
  els.workspace.classList.add('preview-open');
  previewApi?.resize();
}

function closePreview() {
  els.workspace.classList.remove('preview-open');
  previewApi?.resize();
}

function clearPreviewPane() {
  state.preview = null;
  previewApi?.clear();
  els.download.disabled = true;
  els.previewCaption.textContent = '';
  els.previewEmpty.hidden = false;
  // The building list describes what the current outline picked up, so it has to
  // go too, or it keeps offering rows for a selection that no longer exists.
  state.buckets = new Map();
  state.layers = [];
  state.hiddenLayers = new Set();
  renderLayers();
}

async function downloadExport() {
  if (!state.preview) return;
  const { buildings, plate, fitted } = state.preview;
  els.download.disabled = true;
  els.download.textContent = 'Exporting…';

  try {
    const filename = (extension) =>
      `singapore-${centreTag()}-${state.sizeMM}mm` +
      `${plate ? '' : '-noplate'}.${extension}`;

    if (state.format === 'stl') {
      const blob = exportSTL({ positions: buildings, platePositions: plate });
      download(blob, filename('stl'));
    } else {
      const binary = state.format === 'glb';
      const blob = await exportGLTF(
        { positions: buildings, platePositions: plate },
        {
          binary,
          meta: {
            units: fitted.units === 'm' ? 'metres' : 'millimetres',
            scale:
              fitted.units === 'm'
                ? '1:1'
                : `1:${Math.round(fitted.ratio).toLocaleString()}`,
            centre: state.polygon[0],
            plate: {
              included: Boolean(plate),
              thicknessMM: state.thicknessMM,
            },
          },
        },
      );
      download(blob, filename(binary ? 'glb' : 'gltf'));
    }
    els.download.textContent = 'Downloaded!';
    setTimeout(() => {
      els.download.textContent = 'Download';
      els.download.disabled = false;
    }, 1600);
  } catch (error) {
    setStatus(error.message ?? String(error), 'error');
    els.download.textContent = 'Download';
    els.download.disabled = false;
  }
}

function centreTag() {
  const first = state.polygon[0] ?? { lat: 0, lon: 0 };
  return `${first.lat.toFixed(4)}_${first.lon.toFixed(4)}`;
}

function wireUi() {
  for (const button of els.sizeButtons) {
    button.addEventListener('click', () => {
      state.sizeMM = Number(button.dataset.size);
      syncSizeButtons();
      invalidatePreview();
      updateButtons();
    });
  }
  els.sizeCustom.addEventListener('input', () => {
    const value = Number(els.sizeCustom.value);
    if (Number.isFinite(value) && value >= 10 && value <= 400) {
      state.sizeMM = value;
      syncSizeButtons();
      invalidatePreview();
    }
  });

  for (const button of els.formatButtons) {
    button.addEventListener('click', () => {
      state.format = button.dataset.format;
      syncFormatButtons();
      invalidatePreview();
    });
  }
  for (const button of els.scaleButtons) {
    button.addEventListener('click', () => {
      state.scaleMode = button.dataset.scale;
      syncFormatButtons();
      invalidatePreview();
    });
  }

  for (const button of els.schemeButtons) {
    button.addEventListener('click', () => {
      state.scheme = button.dataset.scheme;
      syncSchemeButtons();
      previewApi?.setScheme(state.scheme);
    });
  }

  els.wireframe.addEventListener('click', () => {
    state.wireframe = !state.wireframe;
    els.wireframe.setAttribute('aria-pressed', String(state.wireframe));
    previewApi?.setWireframe(state.wireframe);
    writeSettings();
  });

  els.annotations.addEventListener('click', () => {
    state.annotations = !state.annotations;
    els.annotations.setAttribute('aria-pressed', String(state.annotations));
    previewApi?.setAnnotationsVisible(state.annotations);
    writeSettings();
  });

  els.zoomIn.addEventListener('click', () => previewApi?.zoomBy(1.35));
  els.zoomOut.addEventListener('click', () => previewApi?.zoomBy(1 / 1.35));
  els.refit.addEventListener('click', () => previewApi?.refit());

  // Wheel zoom on the canvas as well as the buttons, matching map conventions.
  els.previewCanvas.addEventListener(
    'wheel',
    (event) => {
      if (!previewApi) return;
      event.preventDefault();
      previewApi.zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18);
    },
    { passive: false },
  );

  els.plate.addEventListener('click', () => {
    state.plateEnabled = !state.plateEnabled;
    syncPlate();
    invalidatePreview();
  });
  els.thickness.addEventListener('input', () => {
    state.thicknessMM = Number(els.thickness.value);
    syncPlate();
    invalidatePreview();
  });
  els.margin.addEventListener('input', () => {
    state.marginMM = Number(els.margin.value);
    syncPlate();
    invalidatePreview();
  });

  els.build.addEventListener('click', () => buildPreview());
  els.download.addEventListener('click', downloadExport);
  els.cancel.addEventListener('click', () => state.abort?.abort());

  els.panelToggle.addEventListener('click', () => {
    const open = els.panel.hidden;
    els.panel.hidden = !open;
    els.panelToggle.setAttribute('aria-expanded', String(open));
    els.panelToggle.title = open ? 'Hide options' : 'Show options';
  });

  els.undo.addEventListener('click', () => mapApi.undo());
  els.clear.addEventListener('click', () => mapApi.clear());
  els.reset.addEventListener('click', () => mapApi.resetRectangle());

  els.previewClose.addEventListener('click', closePreview);

  // Crossing the breakpoint must drop the overlay state: on a wide layout the pane
  // is always visible, and a leftover `.preview-open` would pin it full-screen.
  WIDE_LAYOUT.addEventListener('change', (event) => {
    if (event.matches) els.workspace.classList.remove('preview-open');
    previewApi?.resize();
  });
  window.addEventListener('resize', () => previewApi?.resize());
}

syncSizeButtons();
syncFormatButtons();
syncSchemeButtons();
syncPlate();
// The wireframe/outline buttons are not covered by a sync helper, so reflect the
// restored settings onto them before any rebuild can run.
els.wireframe.setAttribute('aria-pressed', String(state.wireframe));
els.annotations.setAttribute('aria-pressed', String(state.annotations));
wireUi();
updateButtons();

// The first build has to wait for MapLibre to seed the outline, which happens on
// its `load` event; after that every change schedules its own rebuild.
mapApi.map.once('load', () => scheduleLiveBuild());

