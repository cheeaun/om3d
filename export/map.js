import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { CENTER } from './geometry.js';

setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const DEFAULT_ZOOM = 14.5;
const METRES_PER_DEG_LAT = 111320;

const SOURCE_ID = 'export-polygon';
// Side of the square a click starts from when there is no outline yet.
const FIRST_CLICK_SIZE_M = 600;
// Padding around a clicked building's footprint, in screen pixels, so the outline
// clears the walls instead of sitting exactly on them.
const FIRST_CLICK_PADDING_PX = 6;
// Hard cap on the frame a single click can produce. A footprint larger than this
// is really several structures in one source polygon, and framing that silently
// would be worse than making the user drag a handle.
const MAX_CLICK_BOX_M = 450;
// Extra margin around a snapped footprint, as a fraction of its size, so the
// outline clears the walls. A fixed pixel margin also applies at close zooms.
const SNAP_PADDING_FRACTION = 0.08;
const PERSIST_KEY = 'om3d.export.area';

// The dataset covers Singapore only; anything outside this rough box is a stale
// or hand-edited value and is safer to ignore than to restore.
const SG_BOUNDS = { minLat: 1.15, maxLat: 1.5, minLon: 103.55, maxLon: 104.15 };

function isUsablePolygon(polygon) {
  return (
    Array.isArray(polygon) &&
    polygon.length >= 3 &&
    polygon.every(
      (p) =>
        p &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        p.lat >= SG_BOUNDS.minLat &&
        p.lat <= SG_BOUNDS.maxLat &&
        p.lon >= SG_BOUNDS.minLon &&
        p.lon <= SG_BOUNDS.maxLon,
    )
  );
}

function readSavedPolygon() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isUsablePolygon(parsed) ? parsed.map((p) => ({ lat: p.lat, lon: p.lon })) : null;
  } catch {
    return null;
  }
}

function writeSavedPolygon(polygon) {
  try {
    if (isUsablePolygon(polygon)) {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(polygon));
    } else {
      localStorage.removeItem(PERSIST_KEY);
    }
  } catch {
    // Storage can be unavailable in private mode; the page still works.
  }
}

export function createMap({ onPolygonChange }) {
  const map = new MapLibreMap({
    container: 'map',
    style: STYLE_URL,
    center: [CENTER.lon, CENTER.lat],
    zoom: DEFAULT_ZOOM,
    minZoom: 10,
    maxZoom: 19,
    attributionControl: true,
    hash: false,
  });

  map.addControl(new NavigationControl({ showCompass: false }), 'top-left');

  // The map now lives in a CSS grid cell, so its size can change without the
  // window resizing (breakpoint flips, the preview overlay opening).
  const observer = new ResizeObserver(() => map.resize());
  observer.observe(map.getContainer());

  let polygon = [];
  let markers = [];
  let undoStack = [];
  let onChange = onPolygonChange;

  map.on('load', () => {
    emphasiseBuildings(map);
    liftBuildingsAboveRoads(map);
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: emptyGeoJson(),
    });
    map.addLayer({
      id: `${SOURCE_ID}-fill`,
      type: 'fill',
      source: SOURCE_ID,
      paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.18 },
    });
    map.addLayer({
      id: `${SOURCE_ID}-line`,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': '#ff3b30',
        'line-width': 2,
        'line-dasharray': [2, 1.4],
      },
    });
    restoreSavedPolygon();
  });

  function restoreSavedPolygon() {
    const saved = readSavedPolygon();
    if (!saved) return false;
    undoStack = [];
    setPolygon(saved, { record: false, persist: false });
    return true;
  }

  function emphasiseBuildings(mapInstance) {
    const layers = mapInstance.getStyle()?.layers ?? [];
    for (const layer of layers) {
      if (layer['source-layer'] !== 'building' || layer.type !== 'fill') continue;
      try {
        mapInstance.setPaintProperty(
          layer.id,
          'fill-color',
          'rgba(196, 178, 148, 0.85)',
        );
        mapInstance.setPaintProperty(
          layer.id,
          'fill-outline-color',
          'rgba(120, 108, 92, 0.9)',
        );
      } catch {
        // Layer shape varies between styles; fail soft.
      }
    }
  }

  // Positron draws the `building` fill early (layer 8) and every road class after
  // it, so paths and minor roads paint *over* the footprints. For choosing an
  // export area that is misleading: it looks like a footpath is on the roof. The
  // roads are only a location aid here, so move the building fill above every
  // line layer. Symbol layers (labels) stay on top, which is what we want.
  function liftBuildingsAboveRoads(mapInstance) {
    const layers = mapInstance.getStyle()?.layers ?? [];
    const buildingIds = layers
      .filter((l) => l['source-layer'] === 'building' && l.type === 'fill')
      .map((l) => l.id);
    if (!buildingIds.length) return;

    // Find the last line layer that is not a building, then place the buildings
    // immediately after it.
    const lineIds = layers
      .filter((l) => l.type === 'line' && !buildingIds.includes(l.id))
      .map((l) => l.id);
    const anchor = lineIds[lineIds.length - 1];
    if (!anchor) return;

    // The first building layer moves first, then each subsequent one stacks on
    // top of it, so the group ends up contiguous just above the anchor.
    for (const id of buildingIds) {
      try {
        mapInstance.moveLayer(id, anchor);
      } catch {
        // Style shape varies; leave the order alone rather than throwing.
      }
    }
  }

  function emptyGeoJson() {
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[]] },
    };
  }

  function polygonCoordinates() {
    if (polygon.length < 3) return [];
    const ring = polygon.map(({ lon, lat }) => [lon, lat]);
    ring.push([polygon[0].lon, polygon[0].lat]);
    return [ring];
  }

  function refreshSource() {
    const source = map.getSource(SOURCE_ID);
    if (!source) return;
    source.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: polygonCoordinates() },
    });
  }

  function refreshMarkers() {
    for (const marker of markers) marker.remove();
    markers = polygon.map((point, index) => {
      // A wrapper holds the number badge and a delete button side by side. The
      // delete button is what makes removal discoverable; the modifier-click
      // shortcut stays for people who prefer it.
      const element = document.createElement('div');
      element.className = 'vertex';

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'vertex-badge';
      badge.dataset.index = String(index);
      badge.textContent = String(index + 1);
      badge.setAttribute('aria-label', `Vertex ${index + 1}`);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'vertex-remove';
      remove.textContent = '×';
      remove.tabIndex = -1;
      remove.setAttribute('aria-label', `Remove vertex ${index + 1}`);
      remove.title = `Remove vertex ${index + 1}`;
      remove.disabled = polygon.length <= 3;

      // Only the remove button stops propagation. The badge must let pointerdown
      // bubble to the marker element, which is where MapLibre starts the drag.
      remove.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
      });

      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        removeVertex(index);
      });

      badge.addEventListener('pointerdown', (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) {
          event.preventDefault();
          removeVertex(index);
        }
      });

      element.append(badge, remove);

      const marker = new Marker({ element, draggable: true })
        .setLngLat([point.lon, point.lat])
        .addTo(map);

      marker.on('dragstart', () => pushUndo());
      // Update the outline live while dragging, but do not rebuild the markers
      // here: that would remove the very marker being dragged and cancel the drag.
      marker.on('drag', () => {
        const position = marker.getLngLat();
        polygon[index] = { lon: position.lng, lat: position.lat };
        refreshSource();
      });
      marker.on('dragend', () => {
        const position = marker.getLngLat();
        polygon[index] = { lon: position.lng, lat: position.lat };
        refreshSource();
        persist();
        notify();
      });
      return marker;
    });
  }

  function persist() {
    writeSavedPolygon(polygon);
  }

  function notify() {
    onChange?.([...polygon]);
  }

  function pushUndo() {
    undoStack.push(polygon.map((p) => ({ ...p })));
    if (undoStack.length > 40) undoStack.shift();
  }

  function setPolygon(next, { record = true, persist: shouldPersist = true } = {}) {
    if (record) pushUndo();
    polygon = next.map((p) => ({ lon: p.lon, lat: p.lat }));
    refreshSource();
    refreshMarkers();
    if (shouldPersist) persist();
    notify();
  }

  function removeVertex(index) {
    if (polygon.length <= 3) return;
    const next = polygon.filter((_, i) => i !== index);
    setPolygon(next);
  }

  function nearestEdgeInsertion(point) {
    if (polygon.length < 2) {
      return { index: polygon.length, distance: Infinity };
    }
    let bestIndex = polygon.length;
    let bestDistance = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const distance = distanceToSegmentMetres(point, a, b);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i + 1;
      }
    }
    return { index: bestIndex, distance: bestDistance };
  }

  function distanceToSegmentMetres(point, a, b) {
    const latScale = METRES_PER_DEG_LAT;
    const lonScale = METRES_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
    const px = point.lon * lonScale;
    const py = point.lat * latScale;
    const ax = a.lon * lonScale;
    const ay = a.lat * latScale;
    const bx = b.lon * lonScale;
    const by = b.lat * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  // Clicking is how you add a vertex, but a click far from the outline is almost
  // always an accidental tap while panning, and it used to spawn a stray vertex.
  // Only accept a click within this many screen pixels of an existing edge.
  const INSERT_RADIUS_PX = 28;

  function metresPerPixel() {
    // Web-Mercator ground resolution at this latitude and zoom.
    return (
      (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) /
      Math.pow(2, map.getZoom())
    );
  }

  map.on('click', (event) => {
    if (polygon.length === 0) {
      // With no outline yet, the click starts one. If it lands on a building
      // footprint the outline becomes that building's bounding box, which is far
      // more useful than a blind fixed-size square; otherwise fall back to one
      // centred on the click.
      const footprint = buildingBoundsAt(event.point);
      const size = footprint ? null : FIRST_CLICK_SIZE_M;
      setPolygon(
        footprint ?? rectangleAround(event.lngLat.lng, event.lngLat.lat, size),
      );
      return;
    }

    const point = { lon: event.lngLat.lng, lat: event.lngLat.lat };
    const { index, distance } = nearestEdgeInsertion(point);
    if (distance > INSERT_RADIUS_PX * metresPerPixel()) return;

    const next = [...polygon];
    next.splice(index, 0, point);
    setPolygon(next);
  });

  // Bounding box of the building footprint under a screen point, padded so the
  // outline does not sit exactly on the walls. Returns null when the click misses
  // every footprint, which is the common case over water or open ground.
  //
  // A landmark like Marina Bay Sands is a pile of overlapping polygons: the tower,
  // the SkyPark, and a scattering of small decoration/annex shapes. Clicking a
  // decoration is still a click on that landmark, so the **largest** part under
  // the cursor wins, not the smallest — that selects the whole building instead of
  // a stray fragment. OSM features are also MultiPolygons whose parts are separate
  // structures spread across the map (MBS reports 5 disconnected parts), so only
  // parts actually under the click are considered; taking every ring of every hit
  // would union in geometry hundreds of metres away.
  function buildingBoundsAt(point) {
    const layerIds = (map.getStyle()?.layers ?? [])
      .filter((l) => l['source-layer'] === 'building' && l.type === 'fill')
      .map((l) => l.id);
    if (!layerIds.length) return null;

    let features;
    try {
      // Pass screen coordinates as an array: `queryRenderedFeatures` only
      // spatially filters arrays and real `Point` instances, and a plain object
      // silently returns every rendered feature.
      features = map.queryRenderedFeatures([point.x, point.y], {
        layers: layerIds,
      });
    } catch {
      return null;
    }
    if (!features.length) return null;

    const lngLat = map.unproject([point.x, point.y]);
    const target = { lon: lngLat.lng, lat: lngLat.lat };

    // Largest part containing the click. Containment is checked in lon/lat, which
    // is fine because the screen projection is a linear map of it.
    let best = null;
    for (const feature of features) {
      for (const part of polygonParts(feature.geometry)) {
        if (!part.outer.length) continue;
        if (!pointInLngLatRing(target, part.outer)) continue;
        const area = Math.abs(ringLngLatArea(part.outer));
        if (!best || area > best.area) best = { part, area };
      }
    }

    // Nothing contained the click (possible on a shared edge, or when the renderer
    // reports a feature whose ring the point misses by a hair); fall back to the
    // largest part overall rather than snapping to a neighbouring sliver.
    if (!best) {
      for (const feature of features) {
        for (const part of polygonParts(feature.geometry)) {
          if (!part.outer.length) continue;
          const area = Math.abs(ringLngLatArea(part.outer));
          if (!best || area > best.area) best = { part, area };
        }
      }
    }
    if (!best) return null;

    const bounds = new LngLatBounds();
    for (const [lon, lat] of best.part.outer) bounds.extend([lon, lat]);
    for (const hole of best.part.holes) {
      for (const [lon, lat] of hole) bounds.extend([lon, lat]);
    }
    if (bounds.isEmpty()) return null;

    const centerLat = bounds.getCenter().lat;
    const widthM =
      (bounds.getEast() - bounds.getWest()) *
      METRES_PER_DEG_LAT *
      Math.cos((centerLat * Math.PI) / 180);
    const heightM = (bounds.getNorth() - bounds.getSouth()) * METRES_PER_DEG_LAT;

    // A single footprint should never produce a huge frame. Something enormous
    // here means the source polygon spans several structures, so clamp it and let
    // the user drag the handles out rather than silently framing half a district.
    // The cap applies to the *final* box, padding included.
    const centerLng = bounds.getCenter().lng;
    const lngScale = METRES_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);
    const padPx = FIRST_CLICK_PADDING_PX * metresPerPixel();
    const F = SNAP_PADDING_FRACTION;

    // Largest footprint extent whose padded box still fits the cap.
    const fitWithinCap = (extentM) => {
      const pad = Math.max(padPx, extentM * F);
      if (extentM + pad * 2 <= MAX_CLICK_BOX_M) return extentM;
      const byFraction = MAX_CLICK_BOX_M / (1 + F * 2);
      const byPixels = MAX_CLICK_BOX_M - padPx * 2;
      return Math.max(10, Math.min(byFraction, byPixels));
    };

    const finalWidth = fitWithinCap(widthM);
    const finalHeight = fitWithinCap(heightM);
    const pad = Math.max(padPx, Math.max(finalWidth, finalHeight) * F);

    const halfDLat = (finalHeight / 2 + pad) / METRES_PER_DEG_LAT;
    const halfDLon = (finalWidth / 2 + pad) / lngScale;

    const west = centerLng - halfDLon;
    const east = centerLng + halfDLon;
    const south = centerLat - halfDLat;
    const north = centerLat + halfDLat;

    return [
      { lon: west, lat: south },
      { lon: east, lat: south },
      { lon: east, lat: north },
      { lon: west, lat: north },
    ];
  }

  // Splits a GeoJSON Polygon / MultiPolygon into independent `{ outer, holes }`
  // parts, so a site-wide multipolygon can be treated as the separate structures
  // it actually is.
  function polygonParts(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') {
      const [outer, ...holes] = geometry.coordinates;
      return outer?.length ? [{ outer, holes }] : [];
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates
        .filter((poly) => poly?.[0]?.length)
        .map((poly) => ({ outer: poly[0], holes: poly.slice(1) }));
    }
    return [];
  }

  // Even-odd test in lon/lat. Screen projection is a linear map, so testing in
  // geographic space gives the same containment answer without re-projecting.
  function pointInLngLatRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if (
        yi > point.lat !== yj > point.lat &&
        point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  function ringLngLatArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return area / 2;
  }

  function rectangleAround(lon, lat, sizeMetres) {
    const dLat = sizeMetres / 2 / METRES_PER_DEG_LAT;
    const dLon =
      sizeMetres / 2 / (METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    return [
      { lon: lon - dLon, lat: lat - dLat },
      { lon: lon + dLon, lat: lat - dLat },
      { lon: lon + dLon, lat: lat + dLat },
      { lon: lon - dLon, lat: lat + dLat },
    ];
  }

  function setDefaultRectangle() {
    const center = map.getCenter();
    undoStack = [];
    setPolygon(
      rectangleAround(center.lng, center.lat, FIRST_CLICK_SIZE_M),
      { record: false },
    );
  }

  return {
    map,
    getPolygon: () => polygon.map((p) => ({ ...p })),
    setPolygon,
    undo() {
      const previous = undoStack.pop();
      if (previous) setPolygon(previous, { record: false });
    },
    clear() {
      setPolygon([]);
    },
    resetRectangle() {
      setDefaultRectangle();
    },
  };
}
