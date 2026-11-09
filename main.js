import 'mapbox-gl/dist/mapbox-gl.css';
import './style.css';

import mapboxgl from 'mapbox-gl';
import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Tile3DLayer } from '@deck.gl/geo-layers';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';

const ACCESS_TOKEN =
  'pk.eyJ1IjoiY2hlZWF1biIsImEiOiJja3VsNTNvdm0xZTZkMnBuNjFwenVnZ256In0.O7gPe1raOok_uEgY-pCL4g';
mapboxgl.accessToken = ACCESS_TOKEN;

const TILESET_URL =
  new URLSearchParams(window.location.search).get('tiles') ||
  'optimized-tiles/tileset.json';

const ambientLight = new AmbientLight({
  intensity: 1.2,
});

const directionalLight1 = new DirectionalLight({
  color: [228, 226, 226],
  intensity: 2,
  direction: [0, -1, 0.1],
});
const directionalLight2 = new DirectionalLight({
  color: [228, 226, 226],
  intensity: 0.6,
  direction: [0, 1, 0.1],
});
const lightingEffect = new LightingEffect({
  ambientLight,
  directionalLight1,
  directionalLight2,
});

const map = (window._map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  minZoom: 8,
  renderWorldCopies: false,
  hash: true,
  center: [103.857897, 1.285844],
  pitch: 60,
  zoom: 15.5,
  bearing: -30,
  customAttribution: [
    '<a href="https://www.sla.gov.sg/">©️ <abbr title="Singapore Land Authority">SLA</abbr></a> <a href="https://www.onemap.gov.sg/legal/termsofuse.html">©️ OneMap</a>',
  ],
}));
map.addControl(new mapboxgl.NavigationControl());

const overlay = new MapboxOverlay({
  interleaved: true,
  effects: [lightingEffect],
  layers: [],
  // Hide buildings when zoomed out without destroying the 3D tileset state.
  layerFilter: ({ layer, viewport }) =>
    layer.id !== 'buildings-3d' || viewport.zoom >= 13,
});
map.addControl(overlay);
window._overlay = overlay;

map.once('load', () => {
  const layers = map.getStyle().layers;
  const labelLayerId = layers.find(
    (l) => l.type == 'symbol' && l.layout['text-field'],
  )?.id;

  const start = () => {
    const buildingsLayer = new Tile3DLayer({
      id: 'buildings-3d',
      data: TILESET_URL,
      loaders: [Tiles3DLoader],
      // Draw the buildings underneath the map labels.
      beforeId: labelLayerId,
      opacity: 1,
      _subLayerProps: {
        scenegraph: {
          getColor: [255, 255, 255],
          // The Mapbox style fills its depth buffer with near-plane values;
          // testing against it hides the interleaved 3D layer entirely.
          parameters: {
            depthTest: false,
            depthWrite: false,
          },
        },
      },
      loadOptions: {
        tileset: {
          // The defaults. The old values below caused constant tile
          // reloading and far too many network requests:
          //   maximumMemoryUsage: 1 (MB) / maximumScreenSpaceError: 1
          maximumMemoryUsage: 64, // MB
          maximumScreenSpaceError: 8,
        },
      },
      onTileError: (tile, message, url) => {
        console.error(`Failed to load tile ${url}: ${message}`);
      },
    });

    overlay.setProps({ layers: [buildingsLayer] });
  };

  document.getElementById('start-button').onclick = (e) => {
    e.preventDefault();
    start();
    document.getElementById('warning').remove();
    sessionStorage.setItem('started', true);
  };

  if (sessionStorage.getItem('started')) {
    document.getElementById('warning').remove();
    start();
  }
});
