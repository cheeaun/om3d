import './style.css';

import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import { MapboxLayer } from '@deck.gl/mapbox';
import { Tile3DLayer } from '@deck.gl/geo-layers';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';

const ACCESS_TOKEN =
  'pk.eyJ1IjoiY2hlZWF1biIsImEiOiJja3VsNTNvdm0xZTZkMnBuNjFwenVnZ256In0.O7gPe1raOok_uEgY-pCL4g';
mapboxgl.accessToken = ACCESS_TOKEN;
const map = (window._map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v11?optimize=true',
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

const buildingsLayer = new MapboxLayer({
  id: 'buildings-3d',
  type: Tile3DLayer,
  data: 'optimized-tiles/tileset.json',
  loader: Tiles3DLoader,
  opacity: 0.8,
  _subLayerProps: {
    scenegraph: {
      getColor: [228, 226, 226],
    },
  },
  loadOptions: {
    tileset: {
      maximumMemoryUsage: 1,
      // Below doesn't seem to work at all
      viewDistanceScale: 0.5,
      updateTransforms: false,
      maximumScreenSpaceError: 1,
    },
  },
});

const ambientLight = new AmbientLight({
  intensity: 8,
});

const directionalLight1 = new DirectionalLight({
  color: [228, 226, 226],
  intensity: 6,
  direction: [0, -1, 0.1],
});
const directionalLight2 = new DirectionalLight({
  color: [228, 226, 226],
  intensity: 2,
  direction: [0, 1, 0.1],
});
const lightingEffect = new LightingEffect({
  ambientLight,
  directionalLight1,
  directionalLight2,
});

map.once('styledata', () => {
  const layers = map.getStyle().layers;
  const labelLayerId = layers.find(
    (l) => l.type == 'symbol' && l.layout['text-field'],
  ).id;

  map.addLayer({
    id: 'sky',
    type: 'sky',
  });

  const start = () => {
    map.addLayer(buildingsLayer, labelLayerId);
    map.setLayerZoomRange('buildings-3d', 13, 22.1);

    buildingsLayer.deck.setProps({
      effects: [lightingEffect],
    });
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
