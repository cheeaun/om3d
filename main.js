import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GLTFExtensionsPlugin,
  ReorientationPlugin,
} from '3d-tiles-renderer/plugins';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SunCalc from 'suncalc';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Water } from './webgl-water.js';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import { SINGAPORE_OUTLINE } from './singapore-outline.js';
const TILT_SHIFT_BAND_START = 0.16;
const TILT_SHIFT_BAND_END = 0.82;
const TILT_SHIFT_RADIUS = 10;
const TILT_SHIFT_LOD_FULL_ZOOM = 3;
const TILT_SHIFT_LOD_NONE_ZOOM = 10;
const VIGNETTE_STRENGTH = 0.06;
const CLAY_BASE_SHADE = 0.85;
const CLAY_BASE_SHADE_HEIGHT = 6;
const ORTHO_FAR = 200000;
// Distance fog, MapLibre-style. The camera is orthographic, so every ray is
// parallel and a ground fragment's view depth depends only on its screen
// position and the tilt: the ground spans halfHeight / tan(elevation) either
// side of the screen centre. The band is expressed as fractions of that half
// range, so it stays pinned to the screen at every zoom. Because the fog colour
// is the clear colour, the camera far plane can sit inside the band's opaque
// end: clipped geometry is indistinguishable from fog, so the tiles renderer
// frustum-culls the expensive far tiles for free.
//
// Strength rises from 0 at FOG_START_ELEVATION (a moderate tilt) to 1 at
// FOG_FULL_ELEVATION (close to the horizon), and fades back out as the camera
// zooms in: at high zoom the visible ground is only a few blocks wide, so there
// is no far edge to fog and the band would collapse into a smear across the top
// of the screen. These are elevation angles (90 - polar), i.e. the `pitch` in
// `om3dLog()`. Keep them low: the fog should only show up once the camera is
// nearly at the horizon, not on every slight tilt.
//
// The band's fractions map directly to screen rows for an orthographic camera:
// the ground at ndcY = f sits at depth dm + f * halfRange, so the values are
// fractions of the way from the screen centre to its top edge (ndcY 1). Keep
// FAR_END close to 1: everything past it is fully grey, so a low value would
// blank out a big slab of the map instead of fading the horizon. NEAR_START /
// FAR_START park the band past the top edge at zero strength, which is what lets
// it slide in as the camera tilts.
const FOG_START_ELEVATION = 18;
const FOG_FULL_ELEVATION = 5;
const FOG_ZOOM_FADE_START = 6;
const FOG_ZOOM_FADE_END = 14;
const FOG_NEAR_START = 1.3;
const FOG_NEAR_END = 0.45;
const FOG_FAR_START = 1.7;
const FOG_FAR_END = 0.82;
const FOG_CULL_SLACK = 80;
const FOG_CULL_STEP = 0.04;

const TILT_SHIFT_KERNEL = (() => {
  const offsets = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
  const sigma = 0.55;
  const kernel = [];
  let sum = 0;
  for (const y of offsets) {
    for (const x of offsets) {
      const weight = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
      kernel.push({ x, y, weight });
      sum += weight;
    }
  }
  return kernel.map(({ x, y, weight }) => ({
    x,
    y,
    weight: weight / sum,
  }));
})();

const tiltShiftSampleCode = TILT_SHIFT_KERNEL.map(
  ({ x, y, weight }) =>
    `      color += texture2D( tDiffuse, vUv + vec2( ${x.toFixed(4)}, ${y.toFixed(4)} ) * texel ) * ${weight.toFixed(6)};`,
).join('\n');

const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    strength: { value: 1 },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float strength;
    uniform float aspect;
    varying vec2 vUv;

    void main() {
      float distanceFromCenter = abs(vUv.y - 0.5) * 2.0;
      float blurAmount = smoothstep(${TILT_SHIFT_BAND_START}, ${TILT_SHIFT_BAND_END}, distanceFromCenter) * strength;
      vec2 texel = vec2(blurAmount * ${TILT_SHIFT_RADIUS.toFixed(1)}) / resolution;

      vec4 color = texture2D( tDiffuse, vUv );
      if ( blurAmount > 0.0001 ) {
        color = vec4( 0.0 );
${tiltShiftSampleCode}
      }

      vec2 vignetteUv = (vUv - 0.5) * vec2(aspect, 1.0);
      float vignette = 1.0 - ${VIGNETTE_STRENGTH.toFixed(3)} * smoothstep(0.28, 0.95, length(vignetteUv));
      color.rgb *= vignette;

      gl_FragColor = color;
    }
  `,
};

const params = new URLSearchParams(location.search);
const TILESET_URL = params.get('tiles') || '/optimized-tiles/tileset.json';
const AO_ALLOWED = params.get('ao') !== '0';
const FOG_ALLOWED = params.get('fog') !== '0';
let shadowsEnabled = params.get('shadows') === '1';

// Quality tiers trade visual density and effects for memory. The low tier is
// the iOS/Safari default: the basemap texture budget (maxTiles x texture^2) and
// tile cache bytes are what push Mobile Safari over its memory limit when the
// camera tilts and a lot of city becomes visible.
const QUALITY_PRESETS = {
  low: {
    pixelRatio: 1,
    basemapTexture: 512,
    basemapMaxTiles: 28,
    basemapKeepMargin: 1,
    basemapRadius: 3,
    basemapMaxActiveLoads: 2,
    basemapCleanupDelay: 500,
    vectorCache: 64,
    ao: false,
    aoScale: 0.5,
    shadowMap: 1024,
    waterReflection: false,
    waterReflectionScale: 0,
    errorTarget: 24,
    errorTargetMoving: 40,
    maxTilesProcessed: 100,
    lruMinItems: 200,
    lruMaxItems: 500,
    lruMinBytes: 32 * 2 ** 20,
    lruMaxBytes: 96 * 2 ** 20,
  },
  medium: {
    pixelRatio: 1.25,
    basemapTexture: 512,
    basemapMaxTiles: 64,
    basemapKeepMargin: 1,
    basemapRadius: 4,
    basemapMaxActiveLoads: 5,
    basemapCleanupDelay: 1200,
    vectorCache: 128,
    ao: true,
    aoScale: 0.5,
    shadowMap: 2048,
    waterReflection: true,
    waterReflectionScale: 0.25,
    errorTarget: 14,
    errorTargetMoving: 24,
    maxTilesProcessed: 180,
    lruMinItems: 350,
    lruMaxItems: 1000,
    lruMinBytes: 64 * 2 ** 20,
    lruMaxBytes: 192 * 2 ** 20,
  },
  high: {
    pixelRatio: 1.5,
    basemapTexture: 512,
    basemapMaxTiles: 256,
    basemapKeepMargin: 2,
    basemapRadius: 4,
    basemapMaxActiveLoads: 10,
    basemapCleanupDelay: 2000,
    vectorCache: 256,
    ao: true,
    aoScale: 0.5,
    shadowMap: 4096,
    waterReflection: true,
    waterReflectionScale: 0.4,
    errorTarget: 8,
    errorTargetMoving: 16,
    maxTilesProcessed: 300,
    lruMinItems: 600,
    lruMaxItems: 2000,
    lruMinBytes: 192 * 2 ** 20,
    lruMaxBytes: 512 * 2 ** 20,
  },
};

const QUALITY_KEY = 'om3d.quality';

function readStoredQuality() {
  try {
    const stored = localStorage.getItem(QUALITY_KEY);
    return QUALITY_PRESETS[stored] ? stored : null;
  } catch (error) {
    return null;
  }
}

function detectQualityTier() {
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const memory = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;

  if (isIOS || coarse || memory <= 4 || cores <= 4) return 'low';
  if (cores >= 8 && memory >= 8 && window.devicePixelRatio >= 1.5) {
    return 'high';
  }
  return 'medium';
}

const qualityOverride = params.get('quality');
const resolvedQuality =
  qualityOverride && QUALITY_PRESETS[qualityOverride]
    ? qualityOverride
    : readStoredQuality() || detectQualityTier();
let qualityTier = resolvedQuality;
let qualityConfig = QUALITY_PRESETS[qualityTier];
let aoEnabled = AO_ALLOWED && qualityConfig.ao;

const CENTER = { lon: 103.857897, lat: 1.285844 };
const VIEW_SIZE = 1900;
const BASEMAP_MIN_ZOOM = 10;
const BASEMAP_MAX_ZOOM = 22;
const BASEMAP_TILE_SIZE = 256;
const BASEMAP_EXTENT_LIMIT = 80000;
const BASEMAP_Y = -2;
// The land surface stays at BASEMAP_Y + 0.5; the reflective water plane sits
// just under it so it reads as the same level while avoiding z-fighting with
// the land tiles. There are no basement walls.
const LAND_Y = BASEMAP_Y + 0.5;
const WATER_DEPTH = 0.1;
const WATER_Y = LAND_Y - WATER_DEPTH;
const WATER_SIZE = 140000;
const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_SOURCE_MAX_ZOOM = 14;
const BG_COLOR = 0xc4c5c5;
// Sky and fog share one colour so the horizon stays seamless: the fog's opaque
// end has to match the sky, because far tiles that are culled reveal the sky or
// the fogged ground behind them. A light blue reads as distance haze rather than
// a flat grey wall.
const SKY_COLOR = 0xc6dcee;
const FOG_COLOR = SKY_COLOR;
// Mutable copy: the time-of-day lighting tints sky, clear colour and fog
// together so the horizon stays seamless at dawn and dusk as well.
const skyColor = new THREE.Color(SKY_COLOR);
const skyTopColor = new THREE.Color(SKY_COLOR);

const statusEl = document.getElementById('status');
const northArrowEl = document.querySelector('#north .needle');

const attributionEl = document.getElementById('attribution');
attributionEl.textContent =
  '© OpenFreeMap © OpenMapTiles © OpenStreetMap · 3D tiles © SLA / OneMap';

const rendererMode = params.get('renderer') || 'auto';

function createWebGLRenderer() {
  return new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    stencil: true,
  });
}

async function createRenderer() {
  if (rendererMode === 'webgl') {
    return createWebGLRenderer();
  }

  try {
    const { WebGPURenderer } = await import('three/webgpu');
    const webgpuRenderer = new WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
      forceWebGL: rendererMode === 'webgl2',
      stencil: true,
    });
    await webgpuRenderer.init();
    return webgpuRenderer;
  } catch (error) {
    console.warn(
      '[om3d] WebGPU renderer failed; falling back to WebGL2.',
      error,
    );
    return createWebGLRenderer();
  }
}

const renderer = await createRenderer();
const rendererName = renderer.isWebGPURenderer
  ? renderer.backend?.constructor?.name || 'WebGPURenderer'
  : 'WebGLRenderer';
console.info(`[om3d] renderer=${rendererName} webgpu=${!!navigator.gpu}`);

const isWebGPU = !!renderer.isWebGPURenderer;
let WaterMesh = null;
if (isWebGPU) {
  ({ WaterMesh } = await import('./webgpu-water.js'));
}
const BASEMAP_ANISOTROPY = Math.min(
  8,
  renderer.getMaxAnisotropy?.() ??
    renderer.capabilities?.getMaxAnisotropy?.() ??
    1,
);
const SHADOW_INTENSITY = 1;
const SHADOW_CATCHER_OPACITY = isWebGPU ? 0.7 : 0.56;
renderer.setPixelRatio(
  Math.min(window.devicePixelRatio || 1, qualityConfig.pixelRatio),
);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.22;
renderer.shadowMap.enabled = shadowsEnabled;
// Low tier uses a single shadow compare per fragment instead of the PCF
// filter's multi-tap lookup. Shadows are paused while moving, but the shader
// still samples the map, so this is the main per-pixel saving on mobile.
renderer.shadowMap.type =
  qualityTier === 'low' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.setClearColor(skyColor);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = skyColor;
const fog = new THREE.Fog(FOG_COLOR, ORTHO_FAR, ORTHO_FAR * 2);
scene.fog = fog;

const aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  (-VIEW_SIZE * aspect) / 2,
  (VIEW_SIZE * aspect) / 2,
   VIEW_SIZE / 2,
   -VIEW_SIZE / 2,
   1,
   ORTHO_FAR,
);
const DEFAULT_BEARING = -30;
const initialAzimuth =
  Math.PI - THREE.MathUtils.degToRad(DEFAULT_BEARING);
camera.position.set(
  Math.sin(initialAzimuth) * 30000,
  30000,
  Math.cos(initialAzimuth) * 30000,
);
camera.lookAt(0, 0, 0);
camera.zoom = 2;
camera.updateProjectionMatrix();

const controls = new MapControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.enableRotate = true;
controls.minZoom = 0.05;
controls.maxZoom = 91;
// Polar 0 is straight down (pitch 90) and polar PI/2 is the horizon (pitch 0),
// so the pitch bounds are the polar bounds flipped: the 1 degree floor on pitch
// is the PI/2 - 1 degree ceiling on polar.
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI / 2 - THREE.MathUtils.degToRad(1);
controls.dampingFactor = 0.14;
controls.panSpeed = 1.0;
controls.zoomSpeed = 3.5;
controls.rotateSpeed = 1.0;
controls.zoomToCursor = true;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
// One-finger pan stays native; two-finger touch is driven by the custom
// gesture layer below (null makes MapControls ignore it instead of also
// dollying and rotating, which is what made the gesture feel clunky).
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: null,
};
controls.update();

// Fog is updated every frame from the tilt, not toggled by a button: it only
// engages once the camera leans towards the horizon, where the far edge of the
// ground is the expensive part to draw.
const fogState = { strength: 0 };

function updateFog() {
  const elevationDeg =
    90 - THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const strength = FOG_ALLOWED
    ? (1 -
        THREE.MathUtils.smoothstep(
          elevationDeg,
          FOG_FULL_ELEVATION,
          FOG_START_ELEVATION,
        )) *
      (1 -
        THREE.MathUtils.smoothstep(
          camera.zoom,
          FOG_ZOOM_FADE_START,
          FOG_ZOOM_FADE_END,
        ))
    : 0;

  const dm = camera.position.distanceTo(controls.target);
  // Orthographic rays are parallel, so the ground's view depth is dm at the
  // screen centre and grows by halfHeight / tan(elevation) at the top edge.
  // Express the band in fractions of that half-range so it stays pinned to the
  // screen at every zoom instead of tracking world units.
  const halfHeight = VIEW_SIZE / (2 * camera.zoom);
  const tanElevation = Math.tan(
    THREE.MathUtils.degToRad(Math.max(elevationDeg, 1)),
  );
  const halfRange = halfHeight / tanElevation;

  let near = ORTHO_FAR;
  let far = ORTHO_FAR * 2;
  if (strength > 0.001) {
    near = dm + halfRange * THREE.MathUtils.lerp(
      FOG_NEAR_START,
      FOG_NEAR_END,
      strength,
    );
    far = dm + halfRange * THREE.MathUtils.lerp(
      FOG_FAR_START,
      FOG_FAR_END,
      strength,
    );
  }

  fogState.strength = strength;
  fog.near = near;
  fog.far = far;

  // Pull the far plane in so the tiles renderer frustum-culls whatever sits
  // behind the fog. Everything past `far` is fully fogged, so cutting there is
  // invisible, while the slack keeps tall landmarks near the edge from being
  // clipped before the fog paints them out. The plane is quantised (rounded
  // outward, so it never cuts inside the fogged band) to a fraction of the band
  // width, so a slow tilt does not reshuffle the tile set every frame.
  if (strength > 0.001) {
    const step = Math.max((far - near) * FOG_CULL_STEP, 1);
    const farPlane = Math.min(ORTHO_FAR, far + FOG_CULL_SLACK);
    const next = Math.min(ORTHO_FAR, Math.ceil(farPlane / step) * step);
    if (Math.abs(camera.far - next) > step * 0.5) {
      camera.far = next;
      camera.updateProjectionMatrix();
    }
  } else if (camera.far !== ORTHO_FAR) {
    camera.far = ORTHO_FAR;
    camera.updateProjectionMatrix();
  }
}

let tiltShiftPass = null;
let gtaoPass = null;
const AO_RADIUS = 12;
const AO_THICKNESS = 22;
// `AO_BLEND` weights the AO into indirect light and `AO_SCALE` is the AO
// curve's exponent (above 1 crushes contacts, below 1 keeps them light).
const AO_BLEND = 0.8;
const AO_SCALE = 1.3;
const AO_SAMPLES = 8;
// AO is a close-range contact effect: fade it out at overview zooms and when
// the camera is nearly top-down, where it is invisible but still costs a pass.
const AO_FULL_ZOOM = 5;
const AO_NONE_ZOOM = 3.2;
const AO_FULL_ELEVATION = 70;
const AO_NONE_ELEVATION = 85;
const MSAA_SAMPLES = 4;
const composerTarget = renderer.isWebGLRenderer
  ? new THREE.WebGLRenderTarget(
      window.innerWidth * renderer.getPixelRatio(),
      window.innerHeight * renderer.getPixelRatio(),
      { type: THREE.HalfFloatType, samples: MSAA_SAMPLES },
    )
  : null;
if (composerTarget) composerTarget.texture.name = 'EffectComposer.rt1';
const composer = renderer.isWebGLRenderer
  ? new EffectComposer(renderer, composerTarget)
  : null;

function createGTAOPass() {
  gtaoPass = new GTAOPass(
    scene,
    camera,
    window.innerWidth,
    window.innerHeight,
  );
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.blendIntensity = AO_BLEND;
  gtaoPass.updateGtaoMaterial({
    radius: AO_RADIUS,
    thickness: AO_THICKNESS,
    scale: AO_SCALE,
    samples: AO_SAMPLES,
    distanceFallOff: 1,
    screenSpaceRadius: false,
  });
  gtaoPass.enabled = aoEnabled;
  // GTAOPass has no resolution scale: shrink its G-buffer/AO/denoise targets to
  // the tier's scale. The final copy + blend still writes at full size, so the
  // half-resolution AO is simply upsampled.
  const setPassSize = gtaoPass.setSize.bind(gtaoPass);
  gtaoPass.setSize = (width, height) => {
    const scale = qualityConfig.aoScale;
    setPassSize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
  };
  // Reusing the cached AO skips the G-buffer and AO renders; only the two
  // full-screen copy/blend quads remain.
  const renderPass = gtaoPass.render.bind(gtaoPass);
  gtaoPass.render = (
    renderer,
    writeBuffer,
    readBuffer,
    deltaTime,
    maskActive,
  ) => {
    if (aoUpdateThisFrame) {
      renderPass(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    gtaoPass.copyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    gtaoPass.copyMaterial.blending = THREE.NoBlending;
    gtaoPass._renderPass(
      renderer,
      gtaoPass.copyMaterial,
      gtaoPass.renderToScreen ? null : writeBuffer,
    );
    gtaoPass.blendMaterial.uniforms.intensity.value = gtaoPass.blendIntensity;
    gtaoPass.blendMaterial.uniforms.tDiffuse.value =
      gtaoPass.pdRenderTarget.texture;
    gtaoPass._renderPass(
      renderer,
      gtaoPass.blendMaterial,
      gtaoPass.renderToScreen ? null : writeBuffer,
    );
  };
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  gtaoPass.setSize(size.x, size.y);
  return gtaoPass;
}

if (composer) {
  composer.addPass(new RenderPass(scene, camera));
  if (AO_ALLOWED && aoEnabled) {
    composer.addPass(createGTAOPass());
  }
  tiltShiftPass = new ShaderPass(TiltShiftShader);
  tiltShiftPass.uniforms.strength.value = 0;
  composer.addPass(tiltShiftPass);
  composer.addPass(new OutputPass());
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);
}

let renderPipeline = null;
let tiltShiftNodeResolution = null;
let tiltShiftStrengthNode = null;
let frameAspectNode = null;
let renderOutput = null;
let gtaoNode = null;
let webgpuScenePass = null;
let webgpuAOContext = null;
let aoBlurTexel = null;
let aoBlurNode = null;
let aoStrengthNode = null;
let aoStrength = 0;
let aoDirty = true;
let aoUpdateThisFrame = false;
const aoViewMatrix = new THREE.Matrix4();
let aoViewZoom = Number.NaN;
if (isWebGPU) {
  const { RenderPipeline } = await import('three/webgpu');
  const TSL = await import('three/tsl');

  const scenePass = TSL.pass(scene, camera, { samples: MSAA_SAMPLES });
  webgpuScenePass = scenePass;
  const sceneTexture = scenePass.getTextureNode();
  tiltShiftNodeResolution = TSL.uniform(new THREE.Vector2(1, 1));
  tiltShiftStrengthNode = TSL.uniform(0);
  frameAspectNode = TSL.uniform(1);

  if (AO_ALLOWED) {
    const { ao } = await import('three/addons/tsl/display/GTAONode.js');
    const aoPass = ao(scenePass.getTextureNode('depth'), null, camera);
    aoPass.resolutionScale = qualityConfig.aoScale;
    gtaoNode = aoPass;
    aoPass.radius.value = AO_RADIUS;
    aoPass.thickness.value = AO_THICKNESS;
    aoPass.scale.value = AO_SCALE;
    aoPass.samples.value = AO_SAMPLES;
    // The AO only changes when the camera or tile geometry changes; skip the
    // pass on frames where animate() reports no update.
    const renderGTAO = aoPass.updateBefore.bind(aoPass);
    aoPass.updateBefore = (frame) => {
      if (aoUpdateThisFrame) renderGTAO(frame);
    };
    // Apply AO through the material lighting context instead of multiplying the
    // final color: sampling the AO texture in the output pass shows bright
    // fringes along geometry edges on an MSAA target.
    // GTAONode has no denoise (DenoiseNode/TRAANode need a depth/velocity
    // prepass that conflicts with this MSAA scene pass), so blur the raw AO
    // once per update into an AO-resolution target (9 taps) and sample that
    // once per fragment instead of 9 fetches in the lighting shader.
    const aoTexture = aoPass.getTextureNode();
    aoBlurTexel = TSL.uniform(new THREE.Vector2(1, 1));
    const aoTap = (x, y) =>
      aoTexture
        .sample(TSL.screenUV.add(TSL.vec2(x, y).mul(aoBlurTexel)))
        .r;
    const aoBlurred = aoTap(0, 0)
      .mul(0.25)
      .add(aoTap(1, 0).mul(0.125))
      .add(aoTap(-1, 0).mul(0.125))
      .add(aoTap(0, 1).mul(0.125))
      .add(aoTap(0, -1).mul(0.125))
      .add(aoTap(1, 1).mul(0.0625))
      .add(aoTap(-1, 1).mul(0.0625))
      .add(aoTap(1, -1).mul(0.0625))
      .add(aoTap(-1, -1).mul(0.0625));
    aoBlurNode = TSL.rtt(aoBlurred, null, null, {
      resolutionScale: qualityConfig.aoScale,
      autoUpdate: false,
    });
    aoStrengthNode = TSL.uniform(1);
    const aoSample = TSL.mix(
      TSL.float(1),
      aoBlurNode.sample(TSL.screenUV).r,
      aoStrengthNode.mul(AO_BLEND),
    );
    webgpuAOContext = TSL.builtinAOContext(aoSample);
    if (aoEnabled) scenePass.contextNode = webgpuAOContext;
  }

  const tiltShiftNode = TSL.Fn(() => {
    const uvNode = sceneTexture.uvNode || TSL.uv();
    const distanceFromCenter = TSL.abs(uvNode.y.sub(0.5)).mul(2.0);
    const blurAmount = TSL.smoothstep(
      TILT_SHIFT_BAND_START,
      TILT_SHIFT_BAND_END,
      distanceFromCenter,
    ).mul(tiltShiftStrengthNode);
    const texel = TSL.vec2(blurAmount.mul(TILT_SHIFT_RADIUS)).div(
      tiltShiftNodeResolution,
    );

    const color = TSL.vec4(0, 0, 0, 0).toVar();
    TSL.If(blurAmount.greaterThan(0.0001), () => {
      let blur = TSL.vec4(0, 0, 0, 0);
      for (const { x, y, weight } of TILT_SHIFT_KERNEL) {
        blur = blur.add(
          sceneTexture
            .sample(uvNode.add(TSL.vec2(x, y).mul(texel)))
            .mul(weight),
        );
      }
      color.assign(blur);
    }).Else(() => {
      color.assign(sceneTexture.sample(uvNode));
    });
    return color;
  })();

  const vignetteUv = TSL.uv()
    .sub(0.5)
    .mul(TSL.vec2(frameAspectNode, 1));
  const vignette = TSL.float(1).sub(
    TSL.smoothstep(0.28, 0.95, TSL.length(vignetteUv)).mul(
      VIGNETTE_STRENGTH,
    ),
  );
  const finish = (node) => node.mul(vignette);
  renderOutput = finish(tiltShiftNode);
  renderPipeline = new RenderPipeline(renderer, renderOutput);
}

function updateAOResolution() {
  if (!aoBlurTexel) return;
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const scale = qualityConfig.aoScale;
  aoBlurTexel.value.set(
    2.5 / Math.max(1, size.x * scale),
    2.5 / Math.max(1, size.y * scale),
  );
}

function updateTiltShiftResolution() {
  if (!tiltShiftPass && !tiltShiftNodeResolution) return;
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  if (tiltShiftPass) tiltShiftPass.uniforms.resolution.value.copy(size);
  if (tiltShiftNodeResolution) tiltShiftNodeResolution.value.copy(size);
  updateAOResolution();
}

function setAOEnabled(enabled) {
  aoEnabled = Boolean(enabled) && AO_ALLOWED;
  aoDirty = true;
  if (aoEnabled && composer && !gtaoPass) {
    const index = tiltShiftPass
      ? composer.passes.indexOf(tiltShiftPass)
      : composer.passes.length - 1;
    composer.insertPass(createGTAOPass(), Math.max(1, index));
  }
  if (gtaoPass) gtaoPass.enabled = aoEnabled;
  if (webgpuScenePass) {
    webgpuScenePass.contextNode =
      aoEnabled && webgpuAOContext ? webgpuAOContext : null;
    // The context is folded into the material shaders, so bump the pass version
    // to drop its cached context and trigger a rebuild.
    webgpuScenePass.version++;
  }
}

updateTiltShiftResolution();

let panPointer = null;
let rotatePointer = null;
let panSamples = [];
let panInertiaFrame = null;

// Two-finger gestures follow MapLibre's handlers: the centroid pans, the
// finger distance pinches, the finger angle rotates, and a vertical drag with
// side-by-side fingers pitches. The active fingers stay pinned for the whole
// gesture, as MapLibre does, so adding a third finger does not jump the camera.
const touchPointers = new Map();
let touchGesture = null;
let touchGestureFrame = null;

const PAN_INERTIA_BUFFER_MS = 160;
const PAN_INERTIA_WINDOW_MS = 60;

const TOUCH_ROTATION_THRESHOLD_PX = 25;
const TOUCH_PITCH_RAD_PER_PX = THREE.MathUtils.degToRad(0.5);
const TOUCH_PITCH_MOVE_THRESHOLD_PX = 2;
const TOUCH_PITCH_SINGLE_TOUCH_MS = 100;
const TOUCH_ZOOM_THRESHOLD = 0.1;
const TOUCH_ZOOM_SPEED = 1;

function isVertical(v) {
  return Math.abs(v.y) > Math.abs(v.x);
}

function signedAngle(a, b) {
  return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
}

function cancelPanInertia() {
  if (panInertiaFrame === null) return;
  cancelAnimationFrame(panInertiaFrame);
  panInertiaFrame = null;
  controls.enableDamping = true;
}

function bezierEase(t) {
  let low = 0;
  let high = 1;
  let u = t;
  for (let i = 0; i < 8; i++) {
    u = (low + high) / 2;
    const x = 0.9 * u * u * (1 - u) + u * u * u;
    if (x < t) low = u;
    else high = u;
  }
  return 3 * u * u * (1 - u) + u * u * u;
}

function panInertia(amount, durationMs) {
  const speed = Math.max(
    -1400,
    Math.min(1400, (amount * 0.3) / (durationMs / 1000)),
  );
  const duration = Math.abs(speed) / (2500 * 0.3);
  return {
    distance: speed * (duration / 2),
    duration: duration * 1000,
  };
}

function startTouchGesture() {
  const ids = [...touchPointers.keys()].slice(0, 2);
  const a = touchPointers.get(ids[0]);
  const b = touchPointers.get(ids[1]);
  const vector = { x: a.x - b.x, y: a.y - b.y };
  const distance = Math.hypot(vector.x, vector.y);
  // Fingers stacked one above the other can only pan; only side-by-side
  // fingers can be judged as a vertical drag, the same rule MapLibre uses.
  const stacked = isVertical(vector);
  touchGesture = {
    ids,
    points: [
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ],
    mode: stacked ? 'free' : null,
    firstMoveTime: null,
    lastTime: 0,
    // Movement accumulated per finger since the gesture began. Pointer events
    // deliver one finger at a time, so a single event never shows both fingers
    // moving; pitch has to be judged on these running totals.
    total: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    startDistance: distance,
    distance,
    startVector: vector,
    vector,
    minDiameter: distance,
    zoomActive: false,
    rotateActive: false,
  };
}

// Decides whether the gesture is a pitch drag or a free pan/zoom/rotate one.
// `totalA`/`totalB` are each finger's travel since the gesture began, because
// pointer events report one finger at a time, so a single event never shows
// both fingers moving. Returns undefined while it is still too early to tell.
function recognizeTouchGesture(timeStamp, totalA, totalB) {
  const threshold = TOUCH_PITCH_MOVE_THRESHOLD_PX;
  const movedA = Math.hypot(totalA.x, totalA.y) >= threshold;
  const movedB = Math.hypot(totalB.x, totalB.y) >= threshold;
  if (!movedA && !movedB) return undefined;
  if (!movedA || !movedB) {
    if (touchGesture.firstMoveTime === null) {
      touchGesture.firstMoveTime = timeStamp;
    }
    if (timeStamp - touchGesture.firstMoveTime < TOUCH_PITCH_SINGLE_TOUCH_MS) {
      return undefined;
    }
    return false;
  }
  const sameDirection = totalA.y > 0 === totalB.y > 0;
  return isVertical(totalA) && isVertical(totalB) && sameDirection;
}

function applyTouchPitch(moveA, moveB) {
  const yDelta = (moveA.y + moveB.y) / 2;
  if (yDelta === 0) return;
  // Dragging the fingers up tilts the view towards the horizon.
  controls.rotateUp(yDelta * TOUCH_PITCH_RAD_PER_PX);
}

function applyTouchPanZoomRotate(a, b, moveA, moveB) {
  const gesture = touchGesture;

  const panX = (moveA.x + moveB.x) / 2;
  const panY = (moveA.y + moveB.y) / 2;
  if (panX !== 0 || panY !== 0) controls.pan(panX, panY);

  const vector = { x: a.x - b.x, y: a.y - b.y };
  const distance = Math.hypot(vector.x, vector.y);

  if (distance > 0 && gesture.distance > 0) {
    const ratio = distance / gesture.distance;
    if (!gesture.zoomActive) {
      const sinceStart =
        gesture.startDistance > 0
          ? Math.abs(Math.log2(distance / gesture.startDistance))
          : Infinity;
      if (sinceStart >= TOUCH_ZOOM_THRESHOLD) gesture.zoomActive = true;
    }
    if (gesture.zoomActive && ratio !== 1) {
      controls._updateZoomParameters((a.x + b.x) / 2, (a.y + b.y) / 2);
      controls.dollyOut(Math.pow(ratio, TOUCH_ZOOM_SPEED));
    }
  }
  gesture.distance = distance;

  // Rotate by the angle the fingers swept, not by their midpoint drift.
  gesture.minDiameter = Math.min(gesture.minDiameter, distance);
  if (!gesture.rotateActive) {
    const circumference = Math.PI * Math.max(gesture.minDiameter, 1);
    const threshold =
      (TOUCH_ROTATION_THRESHOLD_PX / circumference) * Math.PI * 2;
    if (Math.abs(signedAngle(gesture.startVector, vector)) >= threshold) {
      gesture.rotateActive = true;
      // Start from here so the threshold travel is not applied all at once.
      gesture.vector = vector;
    }
  } else {
    // signedAngle is positive clockwise on screen; rotateLeft is the opposite.
    const delta = signedAngle(gesture.vector, vector);
    if (delta !== 0) controls.rotateLeft(-delta);
    gesture.vector = vector;
  }
}

function processTouchGesture() {
  touchGestureFrame = null;
  if (!touchGesture) return;
  const a = touchPointers.get(touchGesture.ids[0]);
  const b = touchPointers.get(touchGesture.ids[1]);
  if (!a || !b) return;

  const previous = touchGesture.points;
  const moveA = { x: a.x - previous[0].x, y: a.y - previous[0].y };
  const moveB = { x: b.x - previous[1].x, y: b.y - previous[1].y };
  if (moveA.x === 0 && moveA.y === 0 && moveB.x === 0 && moveB.y === 0) {
    return;
  }

  const total = touchGesture.total;
  total[0].x += moveA.x;
  total[0].y += moveA.y;
  total[1].x += moveB.x;
  total[1].y += moveB.y;

  // Pan/zoom/rotate runs from the first move and only hands over to pitch once
  // the fingers prove to be a deliberate vertical drag, as MapLibre does.
  if (touchGesture.mode === null) {
    const isPitch = recognizeTouchGesture(
      touchGesture.lastTime,
      total[0],
      total[1],
    );
    if (isPitch !== undefined) touchGesture.mode = isPitch ? 'pitch' : 'free';
  }

  if (touchGesture.mode === 'pitch') {
    applyTouchPitch(moveA, moveB);
  } else {
    applyTouchPanZoomRotate(a, b, moveA, moveB);
  }

  previous[0].x = a.x;
  previous[0].y = a.y;
  previous[1].x = b.x;
  previous[1].y = b.y;
}

// Pointer events report one finger at a time, so positions are batched and the
// gesture is applied once per frame. This reproduces `touchmove`, which hands
// every finger's position to MapLibre at once; otherwise the gap between the
// fingers appears to wobble and the pinch keeps re-triggering.
function queueTouchGesture(event) {
  if (!touchGesture) return;
  touchGesture.lastTime = event.timeStamp;
  if (touchGestureFrame === null) {
    touchGestureFrame = requestAnimationFrame(processTouchGesture);
  }
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  cancelPanInertia();

  if (event.pointerType === 'touch') {
    touchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (touchPointers.size === 2 && !touchGesture) {
      panPointer = null;
      panSamples = [];
      controls.enableDamping = false;
      startTouchGesture();
      return;
    }
    if (touchPointers.size === 1) {
      // One finger keeps MapControls' native pan; record it here only so the
      // release can hand off to the same inertia as a mouse drag.
      panPointer = event.pointerId;
      panSamples = [
        { t: performance.now(), x: event.clientX, y: event.clientY },
      ];
      controls.enableDamping = false;
    }
    // Extra fingers are ignored so the two fingers that started a gesture keep
    // driving it.
    return;
  }

  if (
    event.button === 2 ||
    (event.button === 0 &&
      (event.ctrlKey || event.metaKey || event.shiftKey))
  ) {
    rotatePointer = event.pointerId;
    controls.enableDamping = false;
    return;
  }

  if (
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }
  panPointer = event.pointerId;
  panSamples = [{ t: performance.now(), x: event.clientX, y: event.clientY }];
  controls.enableDamping = false;
});

renderer.domElement.addEventListener('wheel', cancelPanInertia, {
  passive: true,
});

window.addEventListener('pointermove', (event) => {
  if (
    event.pointerType === 'touch' &&
    touchPointers.has(event.pointerId)
  ) {
    touchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (touchGesture && touchGesture.ids.includes(event.pointerId)) {
      queueTouchGesture(event);
    }
  }

  if (panPointer !== event.pointerId) return;
  const now = performance.now();
  panSamples.push({ t: now, x: event.clientX, y: event.clientY });
  while (
    panSamples.length > 0 &&
    now - panSamples[0].t > PAN_INERTIA_BUFFER_MS
  ) {
    panSamples.shift();
  }
});

function endPan(event) {
  if (panPointer !== event.pointerId) return;
  panPointer = null;
  cancelPanInertia();
  controls.enableDamping = true;

  const releaseTime = performance.now();
  const windowStart = releaseTime - PAN_INERTIA_WINDOW_MS;
  let firstIndex = Math.max(0, panSamples.length - 2);
  while (firstIndex > 0 && panSamples[firstIndex - 1].t >= windowStart) {
    firstIndex--;
  }
  const entries = panSamples.slice(firstIndex);

  if (entries.length >= 2) {
    const first = entries[0];
    const last = entries[entries.length - 1];
    const durationMs = Math.max(1, releaseTime - first.t);
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const amount = Math.hypot(dx, dy);

    if (amount > 1) {
      const inertia = panInertia(amount, durationMs);
      const ux = dx / amount;
      const uy = dy / amount;

      if (inertia.duration > 1 && inertia.distance > 0) {
        controls.enableDamping = false;
        const start = performance.now();
        let previous = 0;
        const step = () => {
          const t = Math.min(
            (performance.now() - start) / inertia.duration,
            1,
          );
          const eased = bezierEase(t);
          const delta = eased - previous;
          previous = eased;
          controls.pan(
            inertia.distance * ux * delta,
            inertia.distance * uy * delta,
          );
          if (t < 1) {
            panInertiaFrame = requestAnimationFrame(step);
          } else {
            panInertiaFrame = null;
            controls.enableDamping = true;
          }
        };
        panInertiaFrame = requestAnimationFrame(step);
      }
    }
  }

  panSamples = [];
}

window.addEventListener('pointerup', endPan);
window.addEventListener('pointercancel', endPan);

function endRotate(event) {
  if (rotatePointer !== event.pointerId) return;
  rotatePointer = null;
  controls.enableDamping = true;
}

window.addEventListener('pointerup', endRotate);
window.addEventListener('pointercancel', endRotate);

function handleTouchPointerEnd(event) {
  if (event.pointerType !== 'touch') return;
  touchPointers.delete(event.pointerId);

  if (!touchGesture || !touchGesture.ids.includes(event.pointerId)) return;

  // Like MapLibre, a gesture ends only when one of the fingers that started it
  // lifts; the remaining finger can then pan on its own. If two or more fingers
  // are still down, start a fresh gesture from them.
  touchGesture = null;
  if (touchGestureFrame !== null) {
    cancelAnimationFrame(touchGestureFrame);
    touchGestureFrame = null;
  }
  controls.enableDamping = true;

  if (touchPointers.size >= 2) startTouchGesture();
}

window.addEventListener('pointerup', handleTouchPointerEnd);
window.addEventListener('pointercancel', handleTouchPointerEnd);

const ambient = new THREE.AmbientLight(
  0xfffdf8,
  shadowsEnabled ? 0.04 : 0.4,
);
scene.add(ambient);

// When shadows are on the sun is often low, so nearly every vertical face is
// indirect-lit. Keep that fill low so the clay does not glow, and tint the
// ground bounce slightly warm so the neutral hemisphere does not read blue
// against the warm key.
const SHADOW_HEMI_INTENSITY = 0.7;
const HEMI_GROUND = 0xe8e9e9;
const SHADOW_HEMI_GROUND = 0xebe8e2;

const hemi = new THREE.HemisphereLight(
  0xffffff,
  shadowsEnabled ? SHADOW_HEMI_GROUND : HEMI_GROUND,
  shadowsEnabled ? SHADOW_HEMI_INTENSITY : 1.15,
);
scene.add(hemi);

const sun = new THREE.DirectionalLight(
  0xfffdfa,
  shadowsEnabled ? 4.7 : 1.2,
);
const DEFAULT_SUN_DIRECTION = new THREE.Vector3(
  -1800,
  2400,
  -1400,
).normalize();
const sunDirection = DEFAULT_SUN_DIRECTION.clone();
sun.position.copy(DEFAULT_SUN_DIRECTION).multiplyScalar(6000);
scene.add(sun, sun.target);

sun.castShadow = shadowsEnabled;
sun.shadow.mapSize.set(
  qualityConfig.shadowMap,
  qualityConfig.shadowMap,
);
sun.shadow.camera.left = -5000;
sun.shadow.camera.right = 5000;
sun.shadow.camera.top = 5000;
sun.shadow.camera.bottom = -5000;
sun.shadow.camera.near = 100;
sun.shadow.camera.far = 12000;
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.2;
sun.shadow.intensity = SHADOW_INTENSITY;

const fill = new THREE.DirectionalLight(
  0xfffdfb,
  shadowsEnabled ? 0.14 : 0.4,
);
fill.position.set(1500, 1300, 1600);
scene.add(fill, fill.target);

let shadowDirty = true;
let lastShadowFocusX = Infinity;
let lastShadowFocusZ = Infinity;
let lastShadowDirX = Infinity;
let lastShadowDirY = Infinity;
let lastShadowDirZ = Infinity;

// Low tier pauses shadows while the camera moves. Tile streaming sets
// shadowDirty on every load/visibility/dispose event, so without this the
// shadow map and coverage map re-render on almost every frame of a pan.
// Toggling `shadow.intensity` is a uniform change, not a material rebuild.
function isShadowPaused() {
  return qualityTier === 'low' && basemapMoving;
}

// The coverage map is a second full scene render with an override material
// used only for subtle building-overlap darkening. On low it is not worth a
// whole extra pass, especially with real shadows on.
function isCoverageEnabled() {
  return shadowsEnabled && qualityTier !== 'low';
}

const SHADOW_SNAP = 600;
const SUN_DISTANCE = 6000;

const COVERAGE_SIZE = 1024;
const MAX_SHADOW_OVERLAP = 3;
const coverageTarget = new THREE.RenderTarget(COVERAGE_SIZE, COVERAGE_SIZE, {
  depthBuffer: false,
  type: THREE.UnsignedByteType,
  format: THREE.RedFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  generateMipmaps: false,
});
coverageTarget.texture.name = 'ShadowCoverage';
coverageTarget.texture.wrapS = THREE.ClampToEdgeWrapping;
coverageTarget.texture.wrapT = THREE.ClampToEdgeWrapping;

const coverageMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  transparent: true,
  toneMapped: false,
  fog: false,
});

function buildCoverageMatrix() {
  const shadowCamera = sun.shadow.camera;
  shadowCamera.updateMatrixWorld();
  shadowCamera.updateProjectionMatrix();
  return new THREE.Matrix4()
    .multiplyMatrices(
      shadowCamera.projectionMatrix,
      shadowCamera.matrixWorldInverse,
    );
}

const coverageMatrix = new THREE.Matrix4();

function renderCoverage() {
  if (!shadowsEnabled || !tiles || !tiles.group.visible) return;

  coverageMatrix.copy(buildCoverageMatrix());

  const prevTarget = renderer.getRenderTarget();
  const prevOverride = scene.overrideMaterial;
  const prevBackground = scene.background;
  const prevAutoClear = renderer.autoClear;

  scene.overrideMaterial = coverageMaterial;
  scene.background = null;

  renderer.setRenderTarget(coverageTarget);
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = true;
  renderer.clear();
  renderer.render(scene, sun.shadow.camera);

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(skyColor, 1);
  renderer.autoClear = prevAutoClear;
  scene.overrideMaterial = prevOverride;
  scene.background = prevBackground;
}

function updateShadowCamera() {
  if (!shadowsEnabled) return;

  const snappedX = Math.round(controls.target.x / SHADOW_SNAP) * SHADOW_SNAP;
  const snappedZ = Math.round(controls.target.z / SHADOW_SNAP) * SHADOW_SNAP;

  const sunMoved =
    sunDirection.x !== lastShadowDirX ||
    sunDirection.y !== lastShadowDirY ||
    sunDirection.z !== lastShadowDirZ;
  const focusMoved =
    snappedX !== lastShadowFocusX || snappedZ !== lastShadowFocusZ;

  if (!sunMoved && !focusMoved) return;

  lastShadowFocusX = snappedX;
  lastShadowFocusZ = snappedZ;
  lastShadowDirX = sunDirection.x;
  lastShadowDirY = sunDirection.y;
  lastShadowDirZ = sunDirection.z;

  sun.position.set(
    snappedX + sunDirection.x * SUN_DISTANCE,
    sunDirection.y * SUN_DISTANCE,
    snappedZ + sunDirection.z * SUN_DISTANCE,
  );
  sun.target.position.set(snappedX, 0, snappedZ);
  sun.target.updateMatrixWorld();

  if (shadowGround) {
    shadowGround.position.set(snappedX, BASEMAP_Y + 1, snappedZ);
  }

  if (shadowsEnabled) shadowDirty = true;
}

const DEBUG_LOG = params.get('debug') === '1';
const METERS_PER_PX_BASE =
  156543.03392 * Math.cos(THREE.MathUtils.degToRad(CENTER.lat));

const WGS84_A = 6378137;
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
const CENTER_PHI = THREE.MathUtils.degToRad(CENTER.lat);
const CENTER_M = (WGS84_A * (1 - WGS84_E2)) /
  Math.pow(1 - WGS84_E2 * Math.sin(CENTER_PHI) ** 2, 1.5);
// Mercator's spherical radius overstates meridian distance by a/M; the basemap
// is the layer carrying that stretch, so compress it to match the 3D tiles
// (true WGS84 ground distances) rather than scaling the tiles.
const BASEMAP_NORTH_SCALE = CENTER_M / WGS84_A;
const CENTER_MERCATOR_Y =
  (1 -
    Math.log(
      Math.tan(THREE.MathUtils.degToRad(CENTER.lat)) +
        1 / Math.cos(THREE.MathUtils.degToRad(CENTER.lat)),
    ) /
      Math.PI) /
  2;

function worldToLonLat(x, z) {
  const size = BASEMAP_TILE_SIZE * METERS_PER_PX_BASE;
  const lon = CENTER.lon - (x * 360) / size;
  const mercY = CENTER_MERCATOR_Y - z / size;
  const lat = THREE.MathUtils.radToDeg(
    Math.atan(Math.sinh(Math.PI * (1 - 2 * mercY))),
  );
  return { lat, lon };
}

function lonLatToWorld(lon, lat) {
  const size = BASEMAP_TILE_SIZE * METERS_PER_PX_BASE;
  const latRad = THREE.MathUtils.degToRad(lat);
  const mercY =
    (1 -
      Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
    2;
  return {
    x: (-(lon - CENTER.lon) * size) / 360,
    z: (CENTER_MERCATOR_Y - mercY) * size,
  };
}

const _dbgNear = new THREE.Vector3();
const _dbgFar = new THREE.Vector3();

function screenToGround(ndcX, ndcY) {
  _dbgNear.set(ndcX, ndcY, -1).unproject(camera);
  _dbgFar.set(ndcX, ndcY, 1).unproject(camera);
  const dy = _dbgFar.y - _dbgNear.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = -_dbgNear.y / dy;
  if (!Number.isFinite(t) || t < 0) return null;
  return {
    x: _dbgNear.x + (_dbgFar.x - _dbgNear.x) * t,
    z: _dbgNear.z + (_dbgFar.z - _dbgNear.z) * t,
  };
}

function getViewportBounds() {
  const corners = [
    screenToGround(-1, 1),
    screenToGround(1, 1),
    screenToGround(-1, -1),
    screenToGround(1, -1),
  ];
  if (corners.some((corner) => !corner)) return null;

  const points = corners.map((corner) => worldToLonLat(corner.x, corner.z));
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  return {
    north: Math.max(...lats),
    south: Math.min(...lats),
    west: Math.min(...lons),
    east: Math.max(...lons),
  };
}

function getGroundFootprint() {
  const corners = [
    screenToGround(-1, 1),
    screenToGround(1, 1),
    screenToGround(-1, -1),
    screenToGround(1, -1),
  ];
  if (corners.some((corner) => !corner)) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const corner of corners) {
    const x = THREE.MathUtils.clamp(
      corner.x,
      -BASEMAP_EXTENT_LIMIT,
      BASEMAP_EXTENT_LIMIT,
    );
    const z = THREE.MathUtils.clamp(
      corner.z,
      -BASEMAP_EXTENT_LIMIT,
      BASEMAP_EXTENT_LIMIT,
    );
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

function getTileStats() {
  if (!tiles) return null;
  let meshes = 0;
  let casting = 0;
  let vertices = 0;
  let hidden = 0;
  tiles.group.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    let isHidden = false;
    let node = child;
    while (node) {
      if (!node.visible) isHidden = true;
      node = node.parent;
    }
    if (isHidden) {
      hidden++;
      return;
    }
    meshes++;
    if (child.castShadow) casting++;
    vertices += child.geometry.attributes.position?.count ?? 0;
  });
  return { meshes, casting, hidden, vertices };
}

function collectMemoryInfo() {
  const info = renderer.info;
  const lru = tiles?.lruCache;
  const stats = tiles?.stats;

  let basemapCanvases = 0;
  let basemapBitmaps = 0;
  for (const texture of basemapTextures.values()) {
    if (texture.image instanceof HTMLCanvasElement) basemapCanvases++;
    else if (
      typeof ImageBitmap !== 'undefined' &&
      texture.image instanceof ImageBitmap
    ) {
      basemapBitmaps++;
    }
  }

  return {
    view: {
      cameraZoom: Number(camera.zoom.toFixed(2)),
      mapZoom: Number(
        Math.log2(
          (METERS_PER_PX_BASE * window.innerHeight * camera.zoom) /
            VIEW_SIZE,
        ).toFixed(2),
      ),
      pitch: Number(
        (90 - THREE.MathUtils.radToDeg(controls.getPolarAngle())).toFixed(1),
      ),
    },
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    textureMB: info.memory.texturesSize
      ? Number((info.memory.texturesSize / 2 ** 20).toFixed(1))
      : null,
    renderTargets: info.memory.renderTargets ?? null,
    shadowType: renderer.shadowMap.type,
    programs: info.programs?.length ?? null,
    calls: info.render.calls,
    triangles: info.render.triangles,
    tiles: tiles
      ? {
          cacheItems: lru.itemSet.size,
          cacheLoaded: lru.loadedSet.size,
          cacheUsed: lru.usedSet.size,
          cacheMB: Number((lru.cachedBytes / 2 ** 20).toFixed(1)),
          queued: stats.queued,
          downloading: stats.downloading,
          parsing: stats.parsing,
          inFrustum: stats.inFrustum,
          visible: stats.visible,
          loadedTotal: tilesLoadedTotal,
          disposedTotal: tilesDisposedTotal,
        }
      : null,
    basemap: {
      meshes: basemapMeshes.size,
      textures: basemapTextures.size,
      canvases: basemapCanvases,
      bitmaps: basemapBitmaps,
      requests: basemapRequests.size,
      queued: basemapTileQueue.length,
      activeLoads: basemapActiveLoads,
      canvasAllocs: basemapCanvasAllocs,
      canvasAllocMB: Number((basemapCanvasBytes / 2 ** 20).toFixed(1)),
      bitmapAllocs: basemapBitmapAllocs,
      bitmapAllocMB: Number((basemapBitmapBytes / 2 ** 20).toFixed(1)),
    },
    vectorTiles: vectorLayerFeatures.size,
  };
}

function buildViewInfo(label) {
  const target = worldToLonLat(controls.target.x, controls.target.z);
  const bounds = getViewportBounds();
  const azimuthDeg = THREE.MathUtils.radToDeg(
    controls.getAzimuthalAngle(),
  );
  const pitch = 90 - THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const bearing = ((180 - azimuthDeg + 540) % 360) - 180;
  const mapZoom = Math.log2(
    (METERS_PER_PX_BASE * window.innerHeight * camera.zoom) / VIEW_SIZE,
  );
  const shadowCamera = sun.shadow.camera;

  const fmt = (value, digits = 5) => Number(value.toFixed(digits));
  const rounded = (value) =>
    Number.isFinite(value) ? Math.round(value) : null;

  return {
    label,
    mapZoom: fmt(mapZoom, 2),
    cameraZoom: fmt(camera.zoom, 2),
    center: { lat: fmt(target.lat), lng: fmt(target.lon) },
    targetWorld: {
      x: Math.round(controls.target.x),
      z: Math.round(controls.target.z),
    },
    bearing: fmt(bearing, 1),
    pitch: fmt(pitch, 1),
    viewport: bounds
      ? {
          north: fmt(bounds.north),
          south: fmt(bounds.south),
          west: fmt(bounds.west),
          east: fmt(bounds.east),
        }
      : null,
    moving: basemapMoving,
    fog: {
      strength: fmt(fogState.strength, 2),
      near: Math.round(fog.near),
      far: Math.round(fog.far),
      cameraFar: Math.round(camera.far),
    },
    shadows: {
      enabled: shadowsEnabled,
      dirty: shadowDirty,
      focus: {
        x: rounded(lastShadowFocusX),
        z: rounded(lastShadowFocusZ),
      },
      halfArea: shadowCamera.right,
      mapSize: sun.shadow.mapSize.x,
      sunDirY: fmt(sunDirection.y, 4),
    },
    lighting: {
      enabled: lightingEnabled,
      blend: fmt(lightingBlend, 2),
      elevation: fmt(lightingElevationDeg, 1),
      phase: getLightingPhase(),
      exposure: fmt(renderer.toneMappingExposure, 2),
    },
    tiles: getTileStats(),
    build: {
      quality: qualityTier,
      pixelRatio: renderer.getPixelRatio(),
      buffer: `${renderer.domElement.width}x${renderer.domElement.height}`,
      basemapZoom: basemapState.zoom,
      basemapTiles: basemapMeshes.size,
      basemapTexture: qualityConfig.basemapTexture,
    },
    memory: collectMemoryInfo(),
  };
}

window.om3dMemory = collectMemoryInfo;

function logViewState(label) {
  const info = buildViewInfo(label);
  console.log(
    `[om3d] ${label} mapZ=${info.mapZoom} lat=${info.center.lat} lng=${info.center.lng} ` +
      `bearing=${info.bearing} pitch=${info.pitch} ` +
      `shadows=${shadowsEnabled ? 'on' : 'off'} moving=${basemapMoving}`,
    info,
  );
  return info;
}

window.om3dLog = logViewState;

const LOG_INTERVAL_MS = 220;
let lastViewLogAt = 0;

controls.addEventListener('change', () => {
  basemapMoving = true;
  clearTimeout(basemapMoveTimer);
  basemapMoveTimer = setTimeout(() => {
    basemapMoving = false;
    if (shadowsEnabled) shadowDirty = true;
    if (DEBUG_LOG) logViewState('idle');
  }, 180);

  if (!DEBUG_LOG) return;
  const now = performance.now();
  if (now - lastViewLogAt >= LOG_INTERVAL_MS) {
    lastViewLogAt = now;
    logViewState('move');
  }
});

// The basemap and its ground fallback are unlit, so the time-of-day lighting
// can only tint them: the material colour multiplies the baked vector tile.
const basemapTint = new THREE.Color(0xffffff);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(12000, 12000),
  new THREE.MeshBasicMaterial({
    color: BG_COLOR,
    toneMapped: false,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = BASEMAP_Y - 1;
scene.add(ground);

const shadowGround = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShadowMaterial({
    color: 0x4a515a,
    opacity: SHADOW_CATCHER_OPACITY,
    transparent: true,
  }),
);
shadowGround.rotation.x = -Math.PI / 2;
shadowGround.scale.set(40000, 40000, 1);
shadowGround.position.y = BASEMAP_Y + 1;
shadowGround.receiveShadow = true;
shadowGround.visible = shadowsEnabled;
scene.add(shadowGround);

const basemapLatRad = THREE.MathUtils.degToRad(CENTER.lat);

function createBasemapState(zoom) {
  const count = 2 ** zoom;
  const metersPerPx =
    (156543.03392 * Math.cos(basemapLatRad)) / count;
  return {
    zoom,
    count,
    centerPx: {
      x: ((CENTER.lon + 180) / 360) * count * BASEMAP_TILE_SIZE,
      y:
        ((1 -
          Math.log(
            Math.tan(basemapLatRad) + 1 / Math.cos(basemapLatRad),
          ) /
            Math.PI) /
          2) *
        count *
        BASEMAP_TILE_SIZE,
    },
    metersPerPx,
    tileMeters: BASEMAP_TILE_SIZE * metersPerPx,
  };
}

let basemapState = createBasemapState(BASEMAP_MAX_ZOOM);

function getBasemapTileRange(state, footprint) {
  const { centerPx, metersPerPx, count } = state;
  const pxMin = centerPx.x - footprint.maxX / metersPerPx;
  const pxMax = centerPx.x - footprint.minX / metersPerPx;
  const pyMin = centerPx.y - footprint.maxZ / metersPerPx;
  const pyMax = centerPx.y - footprint.minZ / metersPerPx;
  const minTx = THREE.MathUtils.clamp(
    Math.floor(pxMin / BASEMAP_TILE_SIZE),
    0,
    count - 1,
  );
  const maxTx = THREE.MathUtils.clamp(
    Math.ceil(pxMax / BASEMAP_TILE_SIZE) - 1,
    0,
    count - 1,
  );
  const minTy = THREE.MathUtils.clamp(
    Math.floor(pyMin / BASEMAP_TILE_SIZE),
    0,
    count - 1,
  );
  const maxTy = THREE.MathUtils.clamp(
    Math.ceil(pyMax / BASEMAP_TILE_SIZE) - 1,
    0,
    count - 1,
  );
  const tiles =
    maxTx < minTx || maxTy < minTy
      ? 0
      : (maxTx - minTx + 1) * (maxTy - minTy + 1);
  return { minTx, maxTx, minTy, maxTy, tiles };
}

const basemapGroup = new THREE.Group();
basemapGroup.scale.z = BASEMAP_NORTH_SCALE;
scene.add(basemapGroup);

// Tileable procedural normal map: octaves of value noise form an isotropic
// height field, differentiated into normals. The water shaders sample it at
// four scales, so it only needs to be seamless, not detailed.
function createWaterNormalTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  const hash = (i, j) => {
    let h = i * 374761393 + j * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  };
  const grids = [8, 16, 32].map((cells) => {
    const grid = new Float32Array(cells * cells);
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        grid[j * cells + i] = hash(i, j);
      }
    }
    return { cells, grid };
  });
  const sampleGrid = ({ cells, grid }, u, v) => {
    const x = u * cells;
    const y = v * cells;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const x0 = ((xi % cells) + cells) % cells;
    const y0 = ((yi % cells) + cells) % cells;
    const x1 = (x0 + 1) % cells;
    const y1 = (y0 + 1) % cells;
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = grid[y0 * cells + x0];
    const b = grid[y0 * cells + x1];
    const c = grid[y1 * cells + x0];
    const d = grid[y1 * cells + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  const amplitudes = [0.55, 0.3, 0.15];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let height = 0;
      for (let i = 0; i < grids.length; i++) {
        height += amplitudes[i] * sampleGrid(grids[i], u, v);
      }
      heights[y * size + x] = height;
    }
  }

  const strength = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const yu = (y - 1 + size) % size;
      const yd = (y + 1) % size;
      const nx = (heights[y * size + xl] - heights[y * size + xr]) * strength;
      const nz = (heights[yu * size + x] - heights[yd * size + x]) * strength;
      const ny = 1;
      const length = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const WATER_NORMALS = createWaterNormalTexture();
const WATER_SUN_COLOR = 0xfff3e2;
const WATER_COLOR = 0x6d838c;
const WATER_LOW_COLOR = 0x9aaeb8;
const WATER_REFLECTIVITY = 0.35;
// A flat map has no globe limb, so the 140 km water sheet would run to the
// edge of the view as an infinite ocean. Dissolve it into the sky between these
// radii (world units are metres) so the sea reads as Singapore's visible cap and
// disappears into haze further out.
const WATER_FADE_START = 18000;
const WATER_FADE_END = 45000;
// World units are metres. The reflection is rendered from a camera mirrored
// about the water plane, so it needs geometry the main camera has already
// culled: a building of height h shows up in the water up to roughly
// h / tan(pitch) further toward the camera than its ground footprint. Tiles
// outside the main frustum are detached from the tiles group and never reach
// the mirror render, which is why tall buildings lost their reflection when
// zoomed in. Keeping every tile within this radius of the view target loaded
// and attached covers the common case cheaply; it is a floor, not a solution
// for arbitrarily tall towers at a very low pitch.
const WATER_REFLECTION_KEEP_RADIUS = 600;

const gpuWaterReflection = isWebGPU
  ? {
      target: new THREE.RenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      }),
      camera: new THREE.PerspectiveCamera(),
      size: new THREE.Vector2(),
      normal: new THREE.Vector3(),
      mirrorWorld: new THREE.Vector3(),
      cameraWorld: new THREE.Vector3(),
      rotation: new THREE.Matrix4(),
      rotationCamera: new THREE.Matrix4(),
      lookAt: new THREE.Vector3(),
      view: new THREE.Vector3(),
      targetPoint: new THREE.Vector3(),
    }
  : null;

function renderGPUWaterReflection() {
  if (!gpuWaterReflection || !water || !qualityConfig.waterReflection) return;

  const { target, camera: mirrorCamera } = gpuWaterReflection;
  renderer.getDrawingBufferSize(gpuWaterReflection.size);
  const scale = qualityConfig.waterReflectionScale;
  const width = Math.max(
    128,
    Math.round(gpuWaterReflection.size.x * scale),
  );
  const height = Math.max(
    128,
    Math.round(gpuWaterReflection.size.y * scale),
  );
  if (target.width !== width || target.height !== height) {
    target.setSize(width, height);
  }

  const normal = gpuWaterReflection.normal
    .set(0, 0, 1)
    .applyMatrix4(
      gpuWaterReflection.rotation.extractRotation(water.matrixWorld),
    );
  const mirrorWorld = gpuWaterReflection.mirrorWorld.setFromMatrixPosition(
    water.matrixWorld,
  );
  const cameraWorld = gpuWaterReflection.cameraWorld.setFromMatrixPosition(
    camera.matrixWorld,
  );
  const view = gpuWaterReflection.view.subVectors(mirrorWorld, cameraWorld);
  if (view.dot(normal) > 0) return;
  view.reflect(normal).negate().add(mirrorWorld);

  const rotation = gpuWaterReflection.rotationCamera.extractRotation(
    camera.matrixWorld,
  );
  const lookAt = gpuWaterReflection.lookAt
    .set(0, 0, -1)
    .applyMatrix4(rotation)
    .add(cameraWorld);
  const targetPoint = gpuWaterReflection.targetPoint
    .subVectors(mirrorWorld, lookAt)
    .reflect(normal)
    .negate()
    .add(mirrorWorld);

  mirrorCamera.position.copy(view);
  mirrorCamera.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
  mirrorCamera.lookAt(targetPoint);
  mirrorCamera.near = camera.near;
  mirrorCamera.far = camera.far;
  mirrorCamera.updateMatrixWorld();
  mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

  const previousVisible = water.visible;
  const previousTarget = renderer.getRenderTarget();
  water.visible = false;
  renderer.setRenderTarget(target);
  renderer.render(scene, mirrorCamera);
  renderer.setRenderTarget(previousTarget);
  water.visible = previousVisible;
}

let water = null;
let waterReflectionFrame = 0;

function disposeWater() {
  if (!water) return;
  scene.remove(water);
  water.geometry.dispose();
  water.material.dispose();
  water.renderTarget?.dispose();
  water = null;
}

function updateWaterLighting() {
  if (!water) return;
  const sunDirectionUniform =
    water.sunDirection ?? water.material?.uniforms?.sunDirection;
  if (!sunDirectionUniform) return;
  sunDirectionUniform.value =
    shadowsEnabled || lightingEnabled ? sunDirection : DEFAULT_SUN_DIRECTION;
}

function createWater() {
  disposeWater();

  const geometry = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE);
  let mesh;

  if (qualityConfig.waterReflection && isWebGPU && WaterMesh) {
    mesh = new WaterMesh(geometry, {
      waterNormals: WATER_NORMALS,
      sunDirection,
      sunColor: new THREE.Color(WATER_SUN_COLOR),
      waterColor: new THREE.Color(WATER_COLOR),
      distortionScale: 5,
      size: 1,
      reflectionTexture: gpuWaterReflection.target.texture,
      reflectivity: WATER_REFLECTIVITY,
      waterFadeColor: skyColor,
      waterFadeStart: WATER_FADE_START,
      waterFadeEnd: WATER_FADE_END,
    });
  } else if (qualityConfig.waterReflection && !isWebGPU) {
    const scale = qualityConfig.waterReflectionScale;
    const reflectionSize = Math.max(
      128,
      Math.round(Math.min(window.innerWidth, window.innerHeight) * scale),
    );
    mesh = new Water(geometry, {
      textureWidth: reflectionSize,
      textureHeight: reflectionSize,
      waterNormals: WATER_NORMALS,
      sunDirection,
      sunColor: WATER_SUN_COLOR,
      waterColor: WATER_COLOR,
      distortionScale: 5,
      reflectivity: WATER_REFLECTIVITY,
      fog: true,
      waterFadeColor: skyColor,
      waterFadeStart: WATER_FADE_START,
      waterFadeEnd: WATER_FADE_END,
    });
  } else {
    mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: WATER_LOW_COLOR,
      }),
    );
  }

  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = WATER_Y;
  mesh.name = 'water';
  water = mesh;
  scene.add(mesh);
  updateWaterLighting();
  applyLighting();
}

const basemapMeshes = new Map();
const basemapTextures = new Map();
const basemapRequests = new Map();
let lastBasemapView = null;
let basemapMoving = false;
let basemapMoveTimer = null;
let basemapStatusHidden = false;
let basemapCleanupTimer = null;
let basemapLevelPending = 0;
let basemapLevelToken = 0;

const basemapTileQueue = [];
let basemapActiveLoads = 0;
let basemapCanvasAllocs = 0;
let basemapCanvasBytes = 0;
let basemapBitmapAllocs = 0;
let basemapBitmapBytes = 0;

function hideBasemapStatus() {
  if (basemapStatusHidden) return;
  basemapStatusHidden = true;
  statusEl.classList.add('hidden');
}

function getDesiredBasemapZoom() {
  const ideal = Math.log2(
    (156543.03392 *
      Math.cos(basemapLatRad) *
      window.innerHeight *
      camera.zoom) /
      VIEW_SIZE,
  );
  return THREE.MathUtils.clamp(
    Math.round(ideal),
    BASEMAP_MIN_ZOOM,
    BASEMAP_MAX_ZOOM,
  );
}

function disposeBasemapTexture(texture) {
  const image = texture.image;
  texture.dispose();
  // ImageBitmaps hold their own backing store; close it explicitly instead of
  // waiting for GC. Canvas fallbacks get zeroed for the same reason on low.
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    image.close();
    return;
  }
  if (qualityTier !== 'low') return;
  // Safari keeps the canvas backing store alive until the element is collected.
  // Zeroing the size releases it immediately instead of leaving it to GC.
  if (image && image.width) {
    image.width = 0;
    image.height = 0;
  }
}

function removeBasemapMesh(key, mesh) {
  basemapGroup.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.map = null;
  mesh.material.dispose();
  releaseBasemapTexture(key);
  basemapMeshes.delete(key);
}

function removeObsoleteLevels() {
  for (const [key, mesh] of basemapMeshes) {
    const zoom = Number(key.split('/')[0]);
    if (zoom !== basemapState.zoom) {
      removeBasemapMesh(key, mesh);
    }
  }
}

function resetBasemap() {
  for (const [key, mesh] of basemapMeshes) {
    removeBasemapMesh(key, mesh);
  }
  basemapMeshes.clear();
  for (const texture of basemapTextures.values()) disposeBasemapTexture(texture);
  basemapTextures.clear();
  basemapRequests.clear();
  basemapTileQueue.length = 0;
  clearTimeout(basemapCleanupTimer);
  basemapLevelToken++;
  basemapLevelPending = 0;
  lastBasemapView = null;
}

function releaseBasemapTexture(key) {
  const texture = basemapTextures.get(key);
  if (!texture) return;
  basemapTextures.delete(key);
  disposeBasemapTexture(texture);
}

const OPENFREEMAP_TILEJSON_TIMEOUT_MS = 15000;
const OPENFREEMAP_TILEJSON_RETRY_MS = 5000;

let openfreemapTileTemplate = null;
let openfreemapTileTemplatePromise = null;
let lastOpenfreemapTileTemplateAttempt = -Infinity;

function loadOpenfreemapTileTemplate() {
  if (openfreemapTileTemplatePromise) return openfreemapTileTemplatePromise;

  // Do not let a stalled request keep the basemap (and the start gate) waiting
  // forever; the caller retries on the next update once this settles empty.
  const signal =
    typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(OPENFREEMAP_TILEJSON_TIMEOUT_MS)
      : undefined;

  openfreemapTileTemplatePromise = fetch(OPENFREEMAP_TILEJSON, { signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((json) => {
      openfreemapTileTemplate = json?.tiles?.[0] ?? null;
      return openfreemapTileTemplate;
    })
    .catch(() => {
      openfreemapTileTemplate = null;
      return null;
    })
    .finally(() => {
      openfreemapTileTemplatePromise = null;
    });

  return openfreemapTileTemplatePromise;
}

function ensureOpenfreemapTileTemplate() {
  if (openfreemapTileTemplate || openfreemapTileTemplatePromise) return;

  const now = performance.now();
  if (now - lastOpenfreemapTileTemplateAttempt < OPENFREEMAP_TILEJSON_RETRY_MS) {
    return;
  }
  lastOpenfreemapTileTemplateAttempt = now;

  loadOpenfreemapTileTemplate().then((template) => {
    if (!template) return;
    lastBasemapView = null;
    updateBasemap();
  });
}

function openfreemapTileUrl(zoom, x, y) {
  if (!openfreemapTileTemplate) return null;
  return openfreemapTileTemplate
    .replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

const vectorLayerFeatures = new Map();

function decodeVectorTile(vectorTile) {
  if (!vectorTile) return null;

  const layers = [];
  for (const layerName of VECTOR_LAYER_ORDER) {
    const layer = vectorTile.layers[layerName];
    if (!layer) continue;

    const features = [];
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const rings = feature.loadGeometry();

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const ring of rings) {
        for (const point of ring) {
          if (point.x < minX) minX = point.x;
          if (point.x > maxX) maxX = point.x;
          if (point.y < minY) minY = point.y;
          if (point.y > maxY) maxY = point.y;
        }
      }
      if (minX > maxX) continue;

      features.push({
        rings,
        minX,
        minY,
        maxX,
        maxY,
        type: feature.type,
        properties: feature.properties,
      });
    }

    layers.push({ name: layerName, features });
  }

  return layers;
}

async function fetchVectorTile(zoom, x, y) {
  const key = `${zoom}/${x}/${y}`;
  const cached = vectorLayerFeatures.get(key);
  if (cached) return cached;

  const url = openfreemapTileUrl(zoom, x, y);

  const request = !url
    ? Promise.resolve(null)
    : fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((buffer) =>
          buffer
            ? decodeVectorTile(
                new VectorTile(new Protobuf(new Uint8Array(buffer))),
              )
            : null,
        )
        .catch(() => null);

  if (vectorLayerFeatures.size >= qualityConfig.vectorCache) {
    vectorLayerFeatures.delete(vectorLayerFeatures.keys().next().value);
  }
  vectorLayerFeatures.set(key, request);
  return request;
}

const VECTOR_BACKGROUND = '#c8c9c9';
const VECTOR_LANDUSE = '#bcbdbc';
const VECTOR_LANDCOVER = '#b8bfbc';
const VECTOR_ROAD = '#8e8f8f';
const VECTOR_PARK = '#b4c8a0';
const VECTOR_WOOD = '#a8bc96';
const VECTOR_GRASS = '#b8c9a5';
const VECTOR_FARMLAND = '#c9c9a6';
const VECTOR_SAND = '#d9d0ba';
const VECTOR_WETLAND = '#aec2b8';
const VECTOR_ROCK = '#c4bfb2';
const VECTOR_COMMERCIAL = '#c6c1ba';
const VECTOR_LANDUSE_GREEN = new Set([
  'park',
  'national_park',
  'nature_reserve',
  'recreation_ground',
  'garden',
  'playground',
  'cemetery',
  'grass',
  'meadow',
  'pitch',
  'stadium',
  'zoo',
]);
const VECTOR_LAYER_ORDER = [
  'landuse',
  'landcover',
  'park',
  'water',
  'waterway',
  'transportation',
];

const VECTOR_EXCLUDED_LANDUSE = new Set([
  'neighbourhood',
  'suburb',
  'quarter',
  'residential',
]);

const VECTOR_ROAD_WIDTHS = {
  motorway: 24,
  trunk: 20,
  primary: 16,
  secondary: 12,
  tertiary: 10,
  minor: 7,
  service: 6,
  path: 2,
  raceway: 6,
};

const VECTOR_EXCLUDED_SUBCLASSES = new Set(['subway']);

const VECTOR_EXCLUDED_CLASSES = new Set([
  'rail',
  'transit',
  'pier',
  'ferry',
  'aerialway',
]);

function vectorRoadWidthMetres(properties) {
  const roadClass = properties.class;
  return VECTOR_ROAD_WIDTHS[roadClass] ?? 5;
}

// The basemap keeps its own land-cover colours (grass, woodland, sand, …); the
// time-of-day tint is multiplied over them by the tile material, so they absorb
// the lighting instead of being replaced by a flat grey.
function vectorFeatureColor(layerName, properties) {
  if (layerName === 'landcover') {
    switch (properties.class) {
      case 'wood':
        return VECTOR_WOOD;
      case 'grass':
        return VECTOR_GRASS;
      case 'farmland':
        return VECTOR_FARMLAND;
      case 'sand':
        return VECTOR_SAND;
      case 'wetland':
        return VECTOR_WETLAND;
      case 'rock':
        return VECTOR_ROCK;
      default:
        return VECTOR_LANDCOVER;
    }
  }
  if (layerName === 'park') return VECTOR_PARK;
  if (layerName === 'landuse') {
    const landuseClass = properties.class;
    if (VECTOR_LANDUSE_GREEN.has(landuseClass)) return VECTOR_PARK;
    if (
      landuseClass === 'commercial' ||
      landuseClass === 'industrial' ||
      landuseClass === 'retail'
    ) {
      return VECTOR_COMMERCIAL;
    }
    return VECTOR_LANDUSE;
  }
  return VECTOR_ROAD;
}

function isVectorRoadDrawn(properties) {
  if (properties.brunnel === 'tunnel') return false;
  if (properties.class?.includes('construction')) return false;
  if (VECTOR_EXCLUDED_CLASSES.has(properties.class)) return false;
  if (VECTOR_EXCLUDED_SUBCLASSES.has(properties.subclass)) return false;
  return true;
}

function drawVectorFeature(ctx, rings, type, transformX, transformY) {
  ctx.beginPath();

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const point = ring[i];
      const px = transformX(point.x);
      const py = transformY(point.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (type === 3) ctx.closePath();
  }

  if (type === 2) ctx.stroke();
  else ctx.fill();
}

const vectorScratchCanvases = new Map();

function getVectorScratchCanvas(size) {
  let canvas = vectorScratchCanvases.get(size);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    vectorScratchCanvases.set(size, canvas);
    basemapCanvasAllocs++;
    basemapCanvasBytes += size * size * 4;
  }
  return canvas;
}

function renderVectorTile(
  canvas,
  layers,
  scale,
  subX,
  subY,
  zoom,
  parentX,
  parentY,
  sourceZoom,
) {
  // Below one canvas pixel per vector unit, Safari's canvas turns thin strokes
  // into separate round-capped segments. Draw supersampled and downscale so
  // the final texture always has at least one pixel per source unit.
  const tileExtent = 4096;
  const targetSize = canvas.width;
  const basePixelsPerUnit = (targetSize * scale) / tileExtent;
  let size = targetSize;
  let sourceCanvas = canvas;
  if (basePixelsPerUnit < 1) {
    const supersampled = Math.min(
      2048,
      Math.ceil(tileExtent / scale),
    );
    if (supersampled > targetSize) {
      size = supersampled;
      // One scratch canvas per size bounds supersampling memory instead of
      // allocating a new canvas for every in-flight tile.
      sourceCanvas = getVectorScratchCanvas(size);
    }
  }

  const context = sourceCanvas.getContext('2d');

  // Everything outside Singapore (and every water polygon) stays transparent,
  // so the reflective water plane below shows through.
  context.clearRect(0, 0, size, size);

  const blit = () => {
    if (sourceCanvas === canvas) return;
    const target = canvas.getContext('2d');
    // The target canvas is shared across tiles now, so clear the previous
    // tile's pixels; otherwise its land shows through this tile's transparent
    // water holes.
    target.globalCompositeOperation = 'source-over';
    target.globalAlpha = 1;
    target.clearRect(0, 0, targetSize, targetSize);
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = 'high';
    target.drawImage(sourceCanvas, 0, 0, targetSize, targetSize);
  };

  if (!layers) {
    blit();
    return;
  }

  const pixelsPerUnit = (size * scale) / tileExtent;
  const transformX = (value) => value * pixelsPerUnit - subX * size;
  const transformY = (value) => value * pixelsPerUnit - subY * size;

  const tileMetres = (BASEMAP_TILE_SIZE * METERS_PER_PX_BASE) / 2 ** zoom;
  const pixelsPerMetre = size / tileMetres;
  const metresToPixels = (metres) =>
    Math.max(1, metres * pixelsPerMetre);

  const clipMinX = subX * (tileExtent / scale);
  const clipMinY = subY * (tileExtent / scale);
  const clipMaxX = clipMinX + tileExtent / scale;
  const clipMaxY = clipMinY + tileExtent / scale;

  context.lineJoin = 'round';
  context.lineCap = 'round';

  let singaporePath = null;
  if (parentX !== undefined) {
    singaporePath = buildSingaporeClipPath(
      transformX,
      transformY,
      parentX,
      parentY,
      sourceZoom,
    );
    if (singaporePath === null) {
      blit();
      return;
    }
    // Fill rather than clip; Safari's clip(Path2D) drops chunks of thick
    // strokes. The finished tile is masked to the outline below instead.
    context.fillStyle = VECTOR_BACKGROUND;
    context.fill(singaporePath);
  }

  for (const { name: layerName, features } of layers) {
    const erase = layerName === 'water' || layerName === 'waterway';
    context.globalCompositeOperation = erase
      ? 'destination-out'
      : 'source-over';
    if (erase) {
      context.fillStyle = '#000000';
      context.strokeStyle = '#000000';
    }

    for (const feature of features) {
      if (
        feature.maxX < clipMinX ||
        feature.minX > clipMaxX ||
        feature.maxY < clipMinY ||
        feature.minY > clipMaxY
      ) {
        continue;
      }

      if (!erase) {
        const color = vectorFeatureColor(layerName, feature.properties);
        context.fillStyle = color;
        context.strokeStyle = color;
      }

      if (layerName === 'transportation') {
        if (feature.type !== 2) continue;
        if (!isVectorRoadDrawn(feature.properties)) continue;

        context.globalAlpha = 1;
        context.lineWidth = metresToPixels(
          vectorRoadWidthMetres(feature.properties),
        );
      } else if (layerName === 'landuse') {
        if (VECTOR_EXCLUDED_LANDUSE.has(feature.properties.class)) continue;
        context.globalAlpha = 1;
        context.lineWidth = Math.max(1, 0.5 * scale);
      } else if (layerName === 'waterway') {
        context.globalAlpha = 1;
        context.lineWidth = metresToPixels(6);
      } else {
        context.globalAlpha = 1;
        context.lineWidth = Math.max(1, 0.5 * scale);
      }

      drawVectorFeature(
        context,
        feature.rings,
        feature.type,
        transformX,
        transformY,
      );
    }
    context.globalAlpha = 1;
  }

  context.globalCompositeOperation = 'source-over';

  if (singaporePath) {
    context.globalCompositeOperation = 'destination-in';
    context.fillStyle = '#000000';
    context.fill(singaporePath);
    context.globalCompositeOperation = 'source-over';
  }

  blit();
}

function lonToTileX(lon, zoom) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToTileY(lat, zoom) {
  const rad = THREE.MathUtils.degToRad(lat);
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    2 ** zoom
  );
}

function buildSingaporeClipPath(
  transformX,
  transformY,
  parentX,
  parentY,
  sourceZoom,
) {
  const path = new Path2D();
  let hasPoints = false;

  for (const ring of SINGAPORE_OUTLINE) {
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];

      const localX =
        (lonToTileX(lon, sourceZoom) - parentX) * 4096;
      const localY =
        (latToTileY(lat, sourceZoom) - parentY) * 4096;

      const px = transformX(localX);
      const py = transformY(localY);

      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
      hasPoints = true;
    }
    path.closePath();
  }

  return hasPoints ? path : null;
}

const CAN_CREATE_IMAGE_BITMAP = typeof createImageBitmap === 'function';

let vectorTileCanvas = null;
let vectorTileRasterLock = Promise.resolve();

function getVectorTileCanvas(size) {
  if (!vectorTileCanvas) vectorTileCanvas = document.createElement('canvas');
  if (
    vectorTileCanvas.width !== size ||
    vectorTileCanvas.height !== size
  ) {
    vectorTileCanvas.width = size;
    vectorTileCanvas.height = size;
    basemapCanvasAllocs++;
    basemapCanvasBytes += size * size * 4;
  }
  return vectorTileCanvas;
}

// Drawing shares one canvas, so hold a lock across the draw and any async
// snapshot. A second tile can then not overwrite the canvas before the bitmap
// has been captured.
async function withVectorTileRasterLock(callback) {
  const previous = vectorTileRasterLock;
  let release;
  vectorTileRasterLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function rasterizeVectorTile(size, draw) {
  return withVectorTileRasterLock(async () => {
    const canvas = getVectorTileCanvas(size);
    draw(canvas);
    return createImageBitmap(canvas, { premultiplyAlpha: 'none' });
  });
}

function configureBasemapTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.x = -1;
  texture.offset.x = 1;
  // Basemap tiles stay close to 1:1 on screen. Mipmapping makes Safari sample
  // a half-resolution level at slight minification, which erodes thin road
  // strokes into dashes; linear sampling keeps them solid (and saves 25%).
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = BASEMAP_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
}

function createCanvasBasemapTexture(draw) {
  // Even with a dedicated target canvas, renderVectorTile may draw into the
  // shared supersampling scratch canvas, so this path needs the same lock.
  return withVectorTileRasterLock(() => {
    const size = qualityConfig.basemapTexture;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    basemapCanvasAllocs++;
    basemapCanvasBytes += size * size * 4;
    draw(canvas);
    return configureBasemapTexture(new THREE.CanvasTexture(canvas));
  });
}

async function loadVectorBasemapTexture(zoom, tx, ty, key, token) {
  const sourceZoom = Math.min(zoom, OPENFREEMAP_SOURCE_MAX_ZOOM);
  const scale = 2 ** (zoom - sourceZoom);
  const parentX = Math.floor(tx / scale);
  const parentY = Math.floor(ty / scale);
  const subX = tx - parentX * scale;
  const subY = ty - parentY * scale;

  const vectorTile = await fetchVectorTile(sourceZoom, parentX, parentY);

  // The camera may have panned past this tile (or switched basemap level)
  // while the fetch was in flight. Skip the supersampled canvas work instead of
  // allocating one only to throw the texture away.
  if (
    !key ||
    !basemapMeshes.has(key) ||
    token !== basemapLevelToken
  ) {
    return null;
  }

  const draw = (canvas) =>
    renderVectorTile(
      canvas,
      vectorTile,
      scale,
      subX,
      subY,
      zoom,
      parentX,
      parentY,
      sourceZoom,
    );

  if (!CAN_CREATE_IMAGE_BITMAP) {
    return createCanvasBasemapTexture(draw);
  }

  const size = qualityConfig.basemapTexture;
  const bitmap = await rasterizeVectorTile(size, draw);
  basemapBitmapAllocs++;
  basemapBitmapBytes += size * size * 4;
  return configureBasemapTexture(new THREE.Texture(bitmap));
}

function loadBasemapTexture(zoom, tx, ty, token) {
  const key = `${zoom}/${tx}/${ty}`;
  if (basemapTextures.has(key)) {
    return Promise.resolve(basemapTextures.get(key));
  }
  if (basemapRequests.has(key)) {
    return basemapRequests.get(key);
  }

  const request = loadVectorBasemapTexture(zoom, tx, ty, key, token);
  basemapRequests.set(key, request);
  request
    .then((texture) => {
      if (!texture) return;
      if (!basemapMeshes.has(key)) {
        disposeBasemapTexture(texture);
        return;
      }
      basemapTextures.set(key, texture);
      hideBasemapStatus();
    })
    .finally(() => {
      if (basemapRequests.get(key) === request) {
        basemapRequests.delete(key);
      }
    });
  return request;
}

function updateBasemap() {
  if (!openfreemapTileTemplate) {
    ensureOpenfreemapTileTemplate();
    return;
  }

  const footprint = getGroundFootprint();
  const desiredZoom = getDesiredBasemapZoom();
  let targetZoom = basemapMoving ? basemapState.zoom : desiredZoom;

  if (footprint) {
    while (
      targetZoom > BASEMAP_MIN_ZOOM &&
      getBasemapTileRange(createBasemapState(targetZoom), footprint).tiles >
        qualityConfig.basemapMaxTiles
    ) {
      targetZoom--;
    }
  }

  if (targetZoom !== basemapState.zoom) {
    // Keep every level at the same height: moving the old level would read as
    // a visible wobble at high zoom. Order is resolved with renderOrder below.
    basemapState = createBasemapState(targetZoom);
    lastBasemapView = null;
    basemapLevelToken++;
    basemapLevelPending = 0;
    basemapTileQueue.length = 0;
    clearTimeout(basemapCleanupTimer);
    // Keep the bridging level only briefly; it is the double-level overlap
    // that costs the most memory.
    basemapCleanupTimer = setTimeout(
      removeObsoleteLevels,
      qualityConfig.basemapCleanupDelay,
    );
  }

  const { centerPx, metersPerPx, tileMeters } = basemapState;
  const px = centerPx.x - controls.target.x / metersPerPx;
  const py = centerPx.y - controls.target.z / metersPerPx;
  const centerTx = Math.floor(px / BASEMAP_TILE_SIZE);
  const centerTy = Math.floor(py / BASEMAP_TILE_SIZE);

  let minTx;
  let maxTx;
  let minTy;
  let maxTy;
  if (footprint) {
    ({ minTx, maxTx, minTy, maxTy } = getBasemapTileRange(
      basemapState,
      footprint,
    ));
  } else {
    minTx = centerTx - qualityConfig.basemapRadius;
    maxTx = centerTx + qualityConfig.basemapRadius;
    minTy = centerTy - qualityConfig.basemapRadius;
    maxTy = centerTy + qualityConfig.basemapRadius;
  }

  const viewKey = [
    basemapState.zoom,
    minTx,
    maxTx,
    minTy,
    maxTy,
    Math.round(controls.getAzimuthalAngle() * 100),
    Math.round(controls.getPolarAngle() * 100),
  ].join('/');

  if (lastBasemapView === viewKey) return;
  lastBasemapView = viewKey;

  for (const [key, mesh] of basemapMeshes) {
    const [zoom, tx, ty] = key.split('/').map(Number);
    if (
      zoom === basemapState.zoom &&
      (tx < minTx - qualityConfig.basemapKeepMargin ||
        tx > maxTx + qualityConfig.basemapKeepMargin ||
        ty < minTy - qualityConfig.basemapKeepMargin ||
        ty > maxTy + qualityConfig.basemapKeepMargin)
    ) {
      removeBasemapMesh(key, mesh);
    }
  }

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const key = `${basemapState.zoom}/${tx}/${ty}`;
      if (basemapMeshes.has(key)) continue;

      const material = new THREE.MeshBasicMaterial({
        color: basemapTint,
        toneMapped: false,
        // Water and the world outside Singapore are transparent in the tile
        // texture; discard those fragments so the reflective water shows.
        alphaTest: 0.5,
      });
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(tileMeters, tileMeters),
        material,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = -100 + basemapState.zoom;
      mesh.visible = false;

      const tileCenterX =
        tx * BASEMAP_TILE_SIZE + BASEMAP_TILE_SIZE / 2;
      const tileCenterY =
        ty * BASEMAP_TILE_SIZE + BASEMAP_TILE_SIZE / 2;
      mesh.position.set(
        -(tileCenterX - centerPx.x) * metersPerPx,
        LAND_Y,
        -(tileCenterY - centerPx.y) * metersPerPx,
      );

      basemapGroup.add(mesh);
      basemapMeshes.set(key, mesh);

      const token = basemapLevelToken;
      const counted =
        !basemapTextures.has(key) && token === basemapLevelToken;
      if (counted) basemapLevelPending++;

      enqueueBasemapTile({
        key,
        zoom: basemapState.zoom,
        tx,
        ty,
        token,
        counted,
        material,
        mesh,
      });
    }
  }
  pumpBasemapQueue();
}

function enqueueBasemapTile(task) {
  basemapTileQueue.push(task);
}

function pumpBasemapQueue() {
  const limit = qualityConfig.basemapMaxActiveLoads;
  while (basemapTileQueue.length > 0 && basemapActiveLoads < limit) {
    const task = basemapTileQueue.shift();
    if (basemapMeshes.get(task.key) !== task.mesh) {
      settleBasemapTile(task);
      continue;
    }

    basemapActiveLoads++;
    loadBasemapTexture(task.zoom, task.tx, task.ty, task.token)
      .then((texture) => {
        if (
          !texture ||
          task.token !== basemapLevelToken ||
          basemapMeshes.get(task.key) !== task.mesh
        ) {
          return;
        }
        task.material.map = texture;
        // Keep the current time-of-day tint. applyLighting() only walks the
        // meshes that exist when the preset changes; a level that loads later
        // must pick up the tint here or the land comes in white/unlit.
        task.material.color.copy(basemapTint);
        task.material.needsUpdate = true;
        task.mesh.visible = true;
      })
      .catch(() => {})
      .finally(() => {
        basemapActiveLoads--;
        settleBasemapTile(task);
        pumpBasemapQueue();
      });
  }
}

function settleBasemapTile(task) {
  if (!task.counted || task.token !== basemapLevelToken) return;
  task.counted = false;
  if (basemapLevelPending > 0) basemapLevelPending--;
  if (basemapLevelPending === 0) removeObsoleteLevels();
}

camera.updateMatrixWorld();

updateBasemap();

let started = false;
let tiles = null;

function start() {
  if (started) return;
  started = true;
  const warning = document.getElementById('warning');
  if (warning) warning.remove();
  tiles = createTilesRenderer(TILESET_URL);
  camera.updateMatrixWorld();
  updateBasemap();
  hideBasemapStatus();
}

const sunControls = document.getElementById('sun-controls');
const sunSlider = document.getElementById('sun-slider');
const sunriseTimeEl = document.getElementById('sunrise-time');
const sunsetTimeEl = document.getElementById('sunset-time');
const sunTimeEl = document.getElementById('sun-time');
const sunDateEl = document.getElementById('sun-date');
const sunResetButton = document.getElementById('sun-reset');

const SUN_TIME_ZONE = 'Asia/Singapore';
const SUN_UTC_OFFSET_MINUTES = 8 * 60;
const sunTimeFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: SUN_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const sunDateFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: SUN_TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function formatSunTime(date) {
  return sunTimeFormatter.format(date).toUpperCase();
}

function setSunDate(date) {
  if (sunDateEl) {
    sunDateEl.textContent = `${sunDateFormatter.format(date)} · SGT`;
  }
}

let sunriseMs = null;
let sunsetMs = null;

// --- Time-of-day lighting -------------------------------------------------
// The sun slider already moves the real SunCalc direction. These presets turn
// that direction into Mapbox-style dawn/day/dusk lighting. Singapore sits on
// the equator, so the sun climbs and drops fast and the air is humid: the warm
// hours are short, the sky stays hazy rather than saturated, and dusk carries
// a little more rose than dawn. The curve is keyed on solar elevation, not
// clock time, which keeps both ends symmetric.
const LIGHTING_STOP_ELEVATIONS = [0, 5, 12, 24, 45];
// Above this elevation the look is plain daylight. The sun panel labels
// anything lower as Dawn or Dusk.
const LIGHTING_DAY_ELEVATION = 18;

const LIGHTING_COLOR_STOPS = {
  sun: [0xffab6a, 0xffb97b, 0xffd1a2, 0xffe9d0, 0xfffdfa],
  // The key is warm but the skylight is not: away from the sun the dome is
  // blue, which is what keeps shaded faces from turning uniformly peach.
  hemiSky: [0xc9d3e4, 0xd3dbe8, 0xe4e9f0, 0xf6f7f9, 0xffffff],
  hemiGround: [0xd8c9bd, 0xe0d5cb, 0xe7e1da, 0xebe8e3, 0xebe8e2],
  fill: [0xd9e3ee, 0xdfe7f0, 0xebeff3, 0xf8f9fb, 0xfffdfb],
  ambient: [0xffe4cd, 0xffe9d6, 0xfff0e2, 0xfff9f1, 0xfffdf8],
  // Horizon/haze colour. The low-sun stops are warmer and more golden so the
  // sky gradient above the water reads like a Singapore sunset, not a flat
  // grey-blue panel.
  sky: [0xe6c3a1, 0xe0cebe, 0xd2d4d4, 0xc8dae9, 0xc6dcee],
  // Zenith colour; the gradient runs from `sky` at the horizon to this at the
  // top of the visible sky band.
  skyTop: [0xc09aa0, 0xb7a6b0, 0xa8b6ca, 0xa2c0e0, 0x9dc1e8],
  basemap: [0xcbb39a, 0xd2c6b9, 0xe0dbd5, 0xf4f3f1, 0xffffff],
  waterSun: [0xffbd86, 0xffc99a, 0xffdcb6, 0xffeeda, 0xfff3e2],
  waterBody: [0x636d73, 0x66737b, 0x6a7a83, 0x6c818a, 0x6d838c],
  waterLow: [0x8a9195, 0x8e989e, 0x949fa5, 0x98a8b0, 0x9aaeb8],
};

const LIGHTING_SCALAR_STOPS = {
  sunIntensity: [2.6, 3.0, 3.7, 4.3, 4.7],
  hemiIntensity: [0.7, 0.78, 0.9, 0.76, 0.7],
  fillIntensity: [0.15, 0.18, 0.23, 0.16, 0.14],
  ambientIntensity: [0.08, 0.09, 0.07, 0.05, 0.04],
  exposure: [1.32, 1.3, 1.27, 1.24, 1.22],
};

const LIGHTING_DUSK_SUN = new THREE.Color(0xffa568);
const LIGHTING_DUSK_SKY = new THREE.Color(0xdcb6a8);
const LIGHTING_DUSK_SKY_TOP = new THREE.Color(0xcf9c97);
const LIGHTING_DUSK_BASEMAP = new THREE.Color(0xc6a99b);

const LIGHTING_BASE_EXPOSURE = 1.22;
const LIGHTING_BASE_SKY = new THREE.Color(SKY_COLOR);
const LIGHTING_BASE_SKY_TOP = new THREE.Color(SKY_COLOR);
const LIGHTING_BASE_BASEMAP = new THREE.Color(0xffffff);
const LIGHTING_BASE_WATER_SUN = new THREE.Color(WATER_SUN_COLOR);
const LIGHTING_BASE_WATER_BODY = new THREE.Color(WATER_COLOR);
const LIGHTING_BASE_WATER_LOW = new THREE.Color(WATER_LOW_COLOR);

// Values used when lighting is off. `shadowed` is what setShadows() used to
// hard-code; `flat` is the no-shadow look. applyLighting() writes these back,
// so the flat look is untouched by this feature.
const LIGHTING_BASE = {
  shadowed: {
    sunColor: new THREE.Color(0xfffdfa),
    sunIntensity: 4.7,
    hemiSky: new THREE.Color(0xffffff),
    hemiGround: new THREE.Color(SHADOW_HEMI_GROUND),
    hemiIntensity: SHADOW_HEMI_INTENSITY,
    fillColor: new THREE.Color(0xfffdfb),
    fillIntensity: 0.14,
    ambientColor: new THREE.Color(0xfffdf8),
    ambientIntensity: 0.04,
  },
  flat: {
    sunColor: new THREE.Color(0xfffdfa),
    sunIntensity: 1.2,
    hemiSky: new THREE.Color(0xffffff),
    hemiGround: new THREE.Color(HEMI_GROUND),
    hemiIntensity: 1.15,
    fillColor: new THREE.Color(0xfffdfb),
    fillIntensity: 0.4,
    ambientColor: new THREE.Color(0xfffdf8),
    ambientIntensity: 0.4,
  },
};

const lightingColorStops = {};
for (const key of Object.keys(LIGHTING_COLOR_STOPS)) {
  lightingColorStops[key] = LIGHTING_COLOR_STOPS[key].map(
    (hex) => new THREE.Color(hex),
  );
}
const LIGHTING_COLOR_KEYS = Object.keys(lightingColorStops);
const LIGHTING_SCALAR_KEYS = Object.keys(LIGHTING_SCALAR_STOPS);
const lightingSample = {};
for (const key of LIGHTING_COLOR_KEYS) {
  lightingSample[key] = new THREE.Color();
}

function sampleLighting(elevationDeg, evening) {
  const stops = LIGHTING_STOP_ELEVATIONS;
  const elevation = THREE.MathUtils.clamp(
    elevationDeg,
    stops[0],
    stops[stops.length - 1],
  );
  let index = 0;
  while (index < stops.length - 2 && elevation >= stops[index + 1]) index++;
  const t = THREE.MathUtils.smoothstep(
    elevation,
    stops[index],
    stops[index + 1],
  );

  for (const key of LIGHTING_COLOR_KEYS) {
    const colors = lightingColorStops[key];
    lightingSample[key].copy(colors[index]).lerp(colors[index + 1], t);
  }
  for (const key of LIGHTING_SCALAR_KEYS) {
    const values = LIGHTING_SCALAR_STOPS[key];
    lightingSample[key] = THREE.MathUtils.lerp(
      values[index],
      values[index + 1],
      t,
    );
  }

  if (evening) {
    const low = 1 - THREE.MathUtils.smoothstep(elevation, 4, 26);
    lightingSample.sun.lerp(LIGHTING_DUSK_SUN, low * 0.45);
    lightingSample.sky.lerp(LIGHTING_DUSK_SKY, low * 0.5);
    lightingSample.skyTop.lerp(LIGHTING_DUSK_SKY_TOP, low * 0.45);
    lightingSample.basemap.lerp(LIGHTING_DUSK_BASEMAP, low * 0.35);
  }

  return lightingSample;
}

const sunPhaseEl = document.getElementById('sun-phase');
const lightingButton = document.getElementById('lighting');

let lightingEnabled = params.get('lighting') === '1';
let lightingElevationDeg = 60;
let lightingEvening = false;
// Blend fades the preset over the flat baseline so toggling the checkbox eases
// instead of snapping. Slider moves update the preset continuously and do not
// need the blend tween.
let lightingBlend = lightingEnabled ? 1 : 0;
let lightingBlendFrame = null;
const LIGHTING_FADE_MS = 450;

function getLightingPhase() {
  if (!lightingEnabled) return 'Sun';
  if (lightingElevationDeg >= LIGHTING_DAY_ELEVATION) return 'Day';
  return lightingEvening ? 'Dusk' : 'Dawn';
}

function updateLightingUI() {
  if (sunPhaseEl) sunPhaseEl.textContent = getLightingPhase();
  // The colours work without shadows, and the time slider is the way to change
  // them, so both the lighting button and the sun panel follow lighting too.
  if (sunControls) {
    sunControls.hidden = !(shadowsEnabled || lightingEnabled);
  }
  if (!lightingButton) return;
  lightingButton.setAttribute('aria-pressed', String(lightingEnabled));
  lightingButton.title = lightingEnabled ? 'Lighting on' : 'Lighting off';
}

function applyLighting() {
  const base = shadowsEnabled ? LIGHTING_BASE.shadowed : LIGHTING_BASE.flat;
  const blend = lightingBlend;
  const preset = sampleLighting(lightingElevationDeg, lightingEvening);
  // Without shadows the preset's heavy key / thin fill would wash out, so only
  // its colours are absorbed: keep the flatter no-shadow intensities.
  const intensity = (baseValue, presetValue) =>
    THREE.MathUtils.lerp(
      baseValue,
      shadowsEnabled ? presetValue : baseValue,
      blend,
    );

  sun.color.copy(base.sunColor).lerp(preset.sun, blend);
  sun.intensity = intensity(base.sunIntensity, preset.sunIntensity);
  hemi.color.copy(base.hemiSky).lerp(preset.hemiSky, blend);
  hemi.groundColor.copy(base.hemiGround).lerp(preset.hemiGround, blend);
  hemi.intensity = intensity(base.hemiIntensity, preset.hemiIntensity);
  fill.color.copy(base.fillColor).lerp(preset.fill, blend);
  fill.intensity = intensity(base.fillIntensity, preset.fillIntensity);
  ambient.color.copy(base.ambientColor).lerp(preset.ambient, blend);
  ambient.intensity = intensity(base.ambientIntensity, preset.ambientIntensity);

  renderer.toneMappingExposure = THREE.MathUtils.lerp(
    LIGHTING_BASE_EXPOSURE,
    shadowsEnabled ? preset.exposure : LIGHTING_BASE_EXPOSURE,
    blend,
  );

  skyColor.copy(LIGHTING_BASE_SKY).lerp(preset.sky, blend);
  skyTopColor.copy(LIGHTING_BASE_SKY_TOP).lerp(preset.skyTop, blend);
  // The glow is the sun's own colour, and it only belongs in the sky while the
  // sun is low enough to sit inside the visible band; a midday sun is far above
  // it, so the glow fades out rather than pinning to the top edge.
  skyGlowColor.copy(preset.sun);
  skyGlowStrength =
    blend *
    (1 -
      THREE.MathUtils.smoothstep(lightingElevationDeg, 14, 32));
  updateSkyGlowPosition();
  scene.background.copy(skyColor);
  renderer.setClearColor(skyColor, 1);
  fog.color.copy(skyColor);

  basemapTint.copy(LIGHTING_BASE_BASEMAP).lerp(preset.basemap, blend);
  for (const mesh of basemapMeshes.values()) {
    mesh.material.color.copy(basemapTint);
  }
  ground.material.color.copy(BG_COLOR).multiply(basemapTint);

  if (water) {
    const waterSun = water.sunColor ?? water.material?.uniforms?.sunColor;
    if (waterSun?.value) {
      waterSun.value.copy(LIGHTING_BASE_WATER_SUN).lerp(preset.waterSun, blend);
    }
    const waterBody = water.waterColor ?? water.material?.uniforms?.waterColor;
    if (waterBody?.value) {
      waterBody.value
        .copy(LIGHTING_BASE_WATER_BODY)
        .lerp(preset.waterBody, blend);
    }
    if (water.material?.isMeshBasicMaterial) {
      water.material.color
        .copy(LIGHTING_BASE_WATER_LOW)
        .lerp(preset.waterLow, blend);
    }
    const waterFade =
      water.waterFadeColor ?? water.material?.uniforms?.waterFadeColor;
    if (waterFade?.value) waterFade.value.copy(skyColor);
  }
}

function updateLightingBlend({ immediate = false } = {}) {
  const target = lightingEnabled ? 1 : 0;
  if (lightingBlendFrame !== null) {
    cancelAnimationFrame(lightingBlendFrame);
    lightingBlendFrame = null;
  }
  if (immediate || target === lightingBlend) {
    lightingBlend = target;
    applyLighting();
    return;
  }

  const from = lightingBlend;
  const startedAt = performance.now();
  const tick = (now) => {
    const t = Math.min((now - startedAt) / LIGHTING_FADE_MS, 1);
    const eased = t * t * (3 - 2 * t);
    lightingBlend = from + (target - from) * eased;
    applyLighting();
    lightingBlendFrame = t < 1 ? requestAnimationFrame(tick) : null;
  };
  lightingBlendFrame = requestAnimationFrame(tick);
}

function setLighting(enabled) {
  lightingEnabled = enabled;
  updateLightingUI();
  updateLightingBlend();
}

// --- Sky gradient ---------------------------------------------------------
// The camera is orthographic, so there is no real horizon: the strip of sky is
// only where the camera far plane has culled the ground. Fit a camera-facing
// plane to that strip so the background can have a vertical gradient; its bottom
// colour is the fog colour, so the horizon seam is invisible.
const SKY_GRADIENT_LAYER = 2;

const SKY_GRADIENT_WIDTH = 256;
const SKY_GRADIENT_HEIGHT = 128;
const skyGradientCanvas = document.createElement('canvas');
skyGradientCanvas.width = SKY_GRADIENT_WIDTH;
skyGradientCanvas.height = SKY_GRADIENT_HEIGHT;
const skyGradientContext = skyGradientCanvas.getContext('2d');
const skyGradientTexture = new THREE.CanvasTexture(skyGradientCanvas);
skyGradientTexture.colorSpace = THREE.SRGBColorSpace;
skyGradientTexture.minFilter = THREE.LinearFilter;
skyGradientTexture.magFilter = THREE.LinearFilter;
skyGradientTexture.generateMipmaps = false;

// The sun is not a mesh: its glow is painted into the same texture as the sky
// gradient, so it is part of the background and geometry drawn afterwards always
// covers it. That is why it cannot show through a building, and it also means
// nothing is drawn at all when the sky band is hidden (no sky = no glow).
const skyGlowColor = new THREE.Color(0xffd9b0);
let skyGlowStrength = 0; // 0..1, from the lighting preset
let skyGlowX = SKY_GRADIENT_WIDTH * 0.5;
let skyGlowY = SKY_GRADIENT_HEIGHT * 0.82;
let skyGlowAspect = 0.3; // rx / ry, keeps the glow round once the strip is stretched
let skyGlowSideFade = 1; // fades out as the sun leaves the view

const SKY_GLOW_HALF_ANGLE = THREE.MathUtils.degToRad(52);
const SKY_GLOW_FADE_START = THREE.MathUtils.degToRad(32);
// Solar elevation at which the glow reaches the top of the sky band.
const SKY_GLOW_MAX_ELEVATION = 34;

const skyGlowSignature = { value: '' };

function updateSkyGlowPosition() {
  // An orthographic camera has no vanishing point, so a direction cannot be
  // projected to a pixel directly. Instead treat the sky band as a backdrop:
  // the sun's azimuth relative to the view slides the glow horizontally, and its
  // elevation raises it, so a low dawn/dusk sun sits on the horizon and a high
  // midday sun climbs to (and past) the top of the band.
  cameraForward
    .setFromMatrixColumn(camera.matrixWorld, 2)
    .negate();
  const sunLength = Math.hypot(sunDirection.x, sunDirection.z);
  const cameraLength = Math.hypot(cameraForward.x, cameraForward.z) || 1;
  let relativeAzimuth = 0;
  if (sunLength > 1e-4) {
    const sx = sunDirection.x / sunLength;
    const sz = sunDirection.z / sunLength;
    const cx = cameraForward.x / cameraLength;
    const cz = cameraForward.z / cameraLength;
    relativeAzimuth = Math.atan2(cx * sz - cz * sx, cx * sx + cz * sz);
  }

  skyGlowX =
    SKY_GRADIENT_WIDTH *
    (0.5 +
      0.5 *
        THREE.MathUtils.clamp(relativeAzimuth / SKY_GLOW_HALF_ANGLE, -1, 1));
  const elevation = THREE.MathUtils.clamp(lightingElevationDeg, 0, 90);
  skyGlowY =
    SKY_GRADIENT_HEIGHT *
    (1 -
      THREE.MathUtils.clamp(elevation / SKY_GLOW_MAX_ELEVATION, 0, 1));
  // Fade the glow out as the sun rotates behind the camera, and keep the last
  // little bit at the edge soft rather than clipping it to a hard arc.
  skyGlowSideFade =
    1 -
    THREE.MathUtils.smoothstep(
      Math.abs(relativeAzimuth),
      SKY_GLOW_FADE_START,
      SKY_GLOW_HALF_ANGLE,
    );

  // The band is wide and short, so the texture is stretched. Squash the glow
  // horizontally by the same ratio to keep it round on screen.
  const signature = `${skyGlowX.toFixed(1)}|${skyGlowY.toFixed(1)}|${skyGlowAspect.toFixed(3)}|${skyGlowSideFade.toFixed(3)}|${skyGlowStrength.toFixed(3)}|${skyGlowColor.getHexString()}`;
  if (signature === skyGlowSignature.value) return;
  skyGlowSignature.value = signature;
  updateSkyGradientTexture();
}

function updateSkyGradientTexture() {
  const ctx = skyGradientContext;
  const width = SKY_GRADIENT_WIDTH;
  const height = SKY_GRADIENT_HEIGHT;

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `#${skyTopColor.getHexString()}`);
  gradient.addColorStop(1, `#${skyColor.getHexString()}`);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const alpha = skyGlowStrength * skyGlowSideFade;
  if (alpha > 0.004) {
    const hex = skyGlowColor.getHexString();
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    ctx.save();
    ctx.translate(skyGlowX, skyGlowY);
    ctx.scale(skyGlowAspect, 1);
    // Purely diffuse: an orthographic view has no parallax, so a crisp disc
    // reads as a decal pinned to the glass. A broad, low-contrast haze reads as
    // light in the air instead, which is what survives panning.
    ctx.globalCompositeOperation = 'lighter';
    const halo = height * 3.2;
    const haloGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, halo);
    haloGradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.3 * alpha})`);
    haloGradient.addColorStop(0.14, `rgba(${r}, ${g}, ${b}, ${0.21 * alpha})`);
    haloGradient.addColorStop(0.32, `rgba(${r}, ${g}, ${b}, ${0.12 * alpha})`);
    haloGradient.addColorStop(0.58, `rgba(${r}, ${g}, ${b}, ${0.05 * alpha})`);
    haloGradient.addColorStop(0.8, `rgba(${r}, ${g}, ${b}, ${0.017 * alpha})`);
    haloGradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = haloGradient;
    ctx.fillRect(-halo, -halo, halo * 2, halo * 2);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  skyGradientTexture.needsUpdate = true;
}
updateSkyGradientTexture();

let MeshBasicNodeMaterialClass = null;
if (isWebGPU) {
  ({ MeshBasicNodeMaterial: MeshBasicNodeMaterialClass } = await import(
    'three/webgpu'
  ));
}
const skyPlaneMaterial = isWebGPU
  ? new MeshBasicNodeMaterialClass({
      map: skyGradientTexture,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    })
  : new THREE.MeshBasicMaterial({
      map: skyGradientTexture,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    });
const skyPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  skyPlaneMaterial,
);
skyPlane.renderOrder = -10000;
skyPlane.frustumCulled = false;
skyPlane.layers.set(SKY_GRADIENT_LAYER);
skyPlane.visible = false;
scene.add(skyPlane);
camera.layers.enable(SKY_GRADIENT_LAYER);

const skyUp = new THREE.Vector3();
const skyForward = new THREE.Vector3();
const cameraForward = new THREE.Vector3();

function updateSky() {
  skyUp.setFromMatrixColumn(camera.matrixWorld, 1);
  skyForward.setFromMatrixColumn(camera.matrixWorld, 2).negate();

  const halfHeight = VIEW_SIZE / (2 * camera.zoom);
  const halfWidth = halfHeight * (window.innerWidth / window.innerHeight);
  const cameraElevation =
    90 - THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const pitchRad = THREE.MathUtils.degToRad(
    Math.max(cameraElevation, 1),
  );
  const viewDistance = camera.position.distanceTo(controls.target);
  const skyBottom = Math.min(
    (camera.far - viewDistance) * Math.tan(pitchRad),
    halfHeight,
  );
  const skyBand = halfHeight - skyBottom;
  if (skyBand <= 0.005 * halfHeight) {
    skyPlane.visible = false;
    return;
  }

  skyPlane.position
    .copy(camera.position)
    .addScaledVector(skyUp, skyBottom + skyBand / 2)
    .addScaledVector(skyForward, 10);
  skyPlane.quaternion.copy(camera.quaternion);
  skyPlane.scale.set(halfWidth * 2 * 1.1, skyBand * 1.08, 1);
  skyPlane.visible = true;

  // The band is stretched to the viewport aspect, so the painted glow has to be
  // squashed by the same ratio or it would read as a wide oval. Both sides are
  // in world units here, which is why the texture dimensions cancel out.
  skyGlowAspect = (skyBand * 1.08) / (halfWidth * 1.1);
}

function updateSunFromSlider() {
  if (!sunSlider || sunriseMs === null || sunsetMs === null) return;

  const max = Math.max(1, Number(sunSlider.max));
  const fraction = THREE.MathUtils.clamp(
    Number(sunSlider.value) / max,
    0,
    1,
  );
  const date = new Date(sunriseMs + (sunsetMs - sunriseMs) * fraction);
  const solar = SunCalc.getPosition(date, CENTER.lat, CENTER.lon);
  const altitudeRad = THREE.MathUtils.degToRad(
    Math.max(4, solar.altitude),
  );
  const azimuthRad = THREE.MathUtils.degToRad(solar.azimuth);
  const horizontal = Math.cos(altitudeRad);

  sunDirection
    .set(
      -Math.sin(azimuthRad) * horizontal,
      Math.sin(altitudeRad),
      Math.cos(azimuthRad) * horizontal,
    )
    .normalize();

  // Without shadows the sun camera does not run, but the directional light
  // should still follow the slider so the colour is not applied from a stale
  // fixed direction.
  if (!shadowsEnabled) {
    sun.position.copy(sunDirection).multiplyScalar(6000);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
  }

  // Lighting follows the true solar altitude, not the 4-degree direction floor:
  // at the sunrise and sunset ends of the slider the sun is on the horizon and
  // the light should read as full golden hour.
  lightingElevationDeg = Math.max(0, solar.altitude);
  lightingEvening = fraction > 0.5;

  const label = formatSunTime(date);
  if (sunTimeEl) sunTimeEl.textContent = label;
  sunSlider.setAttribute('aria-valuetext', label);
  applyLighting();
  updateLightingUI();
  updateWaterLighting();
  if (shadowsEnabled) shadowDirty = true;
}

function setSunToNow() {
  if (!sunSlider || sunriseMs === null || sunsetMs === null) return;

  const now = new Date();
  const nowMs = THREE.MathUtils.clamp(now.getTime(), sunriseMs, sunsetMs);
  sunSlider.value = String(Math.round((nowMs - sunriseMs) / 60000));
  updateSunFromSlider();
  setSunDate(now);
}

if (sunSlider) {
  const now = new Date();
  const times = SunCalc.getTimes(
    now,
    CENTER.lat,
    CENTER.lon,
    0,
    SUN_UTC_OFFSET_MINUTES,
  );
  let sunrise = times.sunrise;
  let sunset = times.sunset;

  if (
    !sunrise ||
    !sunset ||
    !Number.isFinite(sunrise.getTime()) ||
    !Number.isFinite(sunset.getTime()) ||
    sunset <= sunrise
  ) {
    const base = new Date(now);
    sunrise = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      6,
      0,
      0,
    );
    sunset = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      18,
      0,
      0,
    );
  }

  sunriseMs = sunrise.getTime();
  sunsetMs = sunset.getTime();

  const daylightMinutes = Math.max(
    1,
    Math.round((sunsetMs - sunriseMs) / 60000),
  );
  sunSlider.min = '0';
  sunSlider.max = String(daylightMinutes);

  if (sunriseTimeEl) sunriseTimeEl.textContent = formatSunTime(sunrise);
  if (sunsetTimeEl) sunsetTimeEl.textContent = formatSunTime(sunset);
  setSunDate(now);
  setSunToNow();
  sunSlider.addEventListener('input', updateSunFromSlider);
}

if (sunResetButton) {
  sunResetButton.addEventListener('click', setSunToNow);
}

function setShadows(enabled) {
  shadowsEnabled = enabled;
  renderer.shadowMap.enabled = enabled;
  sun.castShadow = enabled;
  if (!enabled) {
    const direction = lightingEnabled ? sunDirection : DEFAULT_SUN_DIRECTION;
    sun.position.copy(direction).multiplyScalar(6000);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    lastShadowFocusX = Infinity;
    lastShadowFocusZ = Infinity;
    lastShadowDirX = Infinity;
    lastShadowDirY = Infinity;
    lastShadowDirZ = Infinity;
  }
  if (shadowGround) shadowGround.visible = enabled && !isShadowPaused();
  // Light colours and intensities live in applyLighting() so the time-of-day
  // preset can fade over them; with lighting off it writes the flat baselines.
  // Lighting now also works without shadows, so it no longer follows the sun
  // panel's visibility.
  updateLightingUI();
  updateLightingBlend();
  if (tiles) {
    // Keeping every off-camera active tile in the scene is a big draw-call
    // multiplier for the shadow camera; skip it on low.
    tiles.displayActiveTiles = enabled && qualityTier !== 'low';
  }
  updateWaterLighting();
  refreshTilesShadowFlags();
  shadowDirty = true;
  renderer.shadowMap.needsUpdate = enabled;
  const coverageOn = isCoverageEnabled() ? 1 : 0;
  coverageUniforms.coverageEnabled.value = coverageOn;
  if (activeClayMaterial.userData?.coverageEnabledNode) {
    activeClayMaterial.userData.coverageEnabledNode.value = coverageOn;
    activeClayMaterial.needsUpdate = true;
  }
  if (!isWebGPU) clayMaterial.needsUpdate = true;
  const button = document.getElementById('shadows');
  if (button) {
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? 'Shadows on' : 'Shadows off';
  }
}

const startButton = document.getElementById('start-button');
if (startButton) {
  startButton.addEventListener('click', start);
} else {
  start();
}

const qualityButtons = Array.from(
  document.querySelectorAll('[data-quality]'),
);
const qualityNote = document.getElementById('quality-note');
const QUALITY_NOTES = {
  low: 'Lighter basemap, no ambient occlusion, smaller tile cache.',
  medium: 'Balanced basemap detail, occlusion and tile cache.',
  high: 'Full basemap detail, occlusion and largest tile cache.',
};

function updateQualityUI() {
  for (const button of qualityButtons) {
    button.setAttribute(
      'aria-checked',
      String(button.dataset.quality === qualityTier),
    );
  }
  if (qualityNote) qualityNote.textContent = QUALITY_NOTES[qualityTier];
}

function setShadowMapSize(size) {
  if (sun.shadow.mapSize.width === size) return;
  sun.shadow.mapSize.set(size, size);
  if (sun.shadow.map) {
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }
  shadowDirty = true;
  if (renderer.shadowMap.enabled) {
    renderer.shadowMap.needsUpdate = true;
  }
}

function applyQuality(tier, { persist = true } = {}) {
  const preset = QUALITY_PRESETS[tier];
  if (!preset || preset === qualityConfig) return;

  qualityTier = tier;
  qualityConfig = preset;
  if (persist) {
    try {
      localStorage.setItem(QUALITY_KEY, tier);
    } catch (error) {
      // Storage can be unavailable in private mode; the session still works.
    }
  }

  setAOEnabled(AO_ALLOWED && preset.ao);
  if (gtaoNode) gtaoNode.resolutionScale = preset.aoScale;
  if (aoBlurNode) aoBlurNode.setResolutionScale(preset.aoScale);
  aoDirty = true;

  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, qualityConfig.pixelRatio),
  );
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  updateTiltShiftResolution();
  updateTilesResolution();

  setShadowMapSize(preset.shadowMap);
  const shadowType =
    qualityTier === 'low' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  if (renderer.shadowMap.type !== shadowType) {
    renderer.shadowMap.type = shadowType;
    shadowDirty = true;
    if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  }

  createWater();

  if (tiles) {
    tiles.lruCache.minSize = preset.lruMinItems;
    tiles.lruCache.maxSize = preset.lruMaxItems;
    tiles.lruCache.minBytesSize = preset.lruMinBytes;
    tiles.lruCache.maxBytesSize = preset.lruMaxBytes;
    tiles.maxTilesProcessed = preset.maxTilesProcessed;
    tiles.errorTarget = basemapMoving
      ? preset.errorTargetMoving
      : preset.errorTarget;
    tiles.displayActiveTiles = shadowsEnabled && qualityTier !== 'low';
  }

  const coverageOn = isCoverageEnabled() ? 1 : 0;
  coverageUniforms.coverageEnabled.value = coverageOn;
  if (activeClayMaterial.userData?.coverageEnabledNode) {
    activeClayMaterial.userData.coverageEnabledNode.value = coverageOn;
    activeClayMaterial.needsUpdate = true;
  }

  resetBasemap();
  updateBasemap();
  updateQualityUI();
}

const settingsButton = document.getElementById('settings');
const settingsPanel = document.getElementById('settings-panel');

function setSettingsOpen(open) {
  if (!settingsButton || !settingsPanel) return;
  settingsPanel.hidden = !open;
  settingsButton.setAttribute('aria-expanded', String(open));
}

if (settingsButton && settingsPanel) {
  settingsButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setSettingsOpen(settingsPanel.hidden);
  });
  document.addEventListener('click', (event) => {
    if (settingsPanel.hidden) return;
    if (
      settingsPanel.contains(event.target) ||
      settingsButton.contains(event.target)
    ) {
      return;
    }
    setSettingsOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSettingsOpen(false);
  });
}

for (const button of qualityButtons) {
  button.addEventListener('click', () => {
    applyQuality(button.dataset.quality);
  });
}

const copyDebugButton = document.getElementById('copy-debug');
const COPY_DEBUG_LABEL = 'Copy debug info';

async function copyDebugInfo() {
  const text = JSON.stringify(buildViewInfo('copy'), null, 2);
  let copied = false;

  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (error) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand('copy');
      area.remove();
    } catch (fallbackError) {
      copied = false;
    }
  }

  if (!copyDebugButton) return;
  copyDebugButton.textContent = copied ? 'Copied!' : 'Copy failed';
  clearTimeout(copyDebugButton.copyTimer);
  copyDebugButton.copyTimer = setTimeout(() => {
    copyDebugButton.textContent = COPY_DEBUG_LABEL;
  }, 1600);
}

if (copyDebugButton) {
  copyDebugButton.addEventListener('click', copyDebugInfo);
}

updateQualityUI();

const shadowsButton = document.getElementById('shadows');
if (shadowsButton) {
  shadowsButton.addEventListener('click', () => {
    setShadows(!shadowsEnabled);
  });
}

if (lightingButton) {
  lightingButton.addEventListener('click', () => {
    setLighting(!lightingEnabled);
  });
}

const tiltShiftButton = document.getElementById('tilt-shift');
let tiltShiftEnabled = false;
let tiltShiftStrength = 0;

// Tilt shift is a small-scale, overview effect. Fade it out as the camera
// zooms in and the tile LOD switches to detailed geometry, which reads as
// mush when blurred.
function updateTiltShiftStrength() {
  const strength = tiltShiftEnabled
    ? 1 -
      THREE.MathUtils.smoothstep(
        camera.zoom,
        TILT_SHIFT_LOD_FULL_ZOOM,
        TILT_SHIFT_LOD_NONE_ZOOM,
      )
    : 0;
  if (strength === tiltShiftStrength) return;
  tiltShiftStrength = strength;
  if (tiltShiftPass) tiltShiftPass.uniforms.strength.value = strength;
  if (tiltShiftStrengthNode) tiltShiftStrengthNode.value = strength;
}

function updateAOStrength() {
  let strength = 0;
  if (aoEnabled) {
    const zoomFade = THREE.MathUtils.smoothstep(
      camera.zoom,
      AO_NONE_ZOOM,
      AO_FULL_ZOOM,
    );
    const elevation = 90 - THREE.MathUtils.radToDeg(controls.getPolarAngle());
    const pitchFade =
      1 -
      THREE.MathUtils.smoothstep(
        elevation,
        AO_FULL_ELEVATION,
        AO_NONE_ELEVATION,
      );
    strength = zoomFade * pitchFade;
  }
  aoStrength = strength;
  if (gtaoPass) {
    gtaoPass.blendIntensity = AO_BLEND * strength;
    gtaoPass.enabled = aoEnabled && strength > 0.001;
  }
  if (aoStrengthNode) aoStrengthNode.value = strength;
  return strength;
}

function setTiltShift(enabled) {
  tiltShiftEnabled = enabled;
  updateTiltShiftStrength();
  if (tiltShiftButton) {
    tiltShiftButton.setAttribute('aria-pressed', String(enabled));
    tiltShiftButton.title = enabled ? 'Tilt shift on' : 'Tilt shift off';
  }
}

if (tiltShiftButton) {
  tiltShiftButton.setAttribute('aria-pressed', String(tiltShiftEnabled));
  tiltShiftButton.title = 'Tilt shift off';
  tiltShiftButton.addEventListener('click', () => {
    setTiltShift(!tiltShiftEnabled);
  });
}

// --- Stepped rotate / tilt buttons ---------------------------------------
// Both button pairs move the camera one grid step at a time, animated over
// ROTATE_DURATION. Read this before changing anything here, because the sign
// conventions are not obvious:
//
//   pitch = 90 - polar      (polar 0 = straight down, polar PI/2 = horizon)
//   bearing = 180 - azimuth (controls.getAzimuthalAngle(), wrapped to +-180)
//
// So "rotate right" (clockwise on screen) *decreases* bearing, i.e. *increases*
// azimuth, and "tilt up" increases pitch, i.e. *decreases* polar. Both
// stepTarget() callers therefore pass the opposite sign to what the label says.
//
// The camera is posed absolutely (setCameraAzimuth / setCameraPitch) rather
// than through controls.rotateLeft()/rotateUp(): those accumulate into
// _sphericalDelta and only apply on update(), so driving them from a per-frame
// tween re-applies the correction each frame and overshoots wildly.

const ROTATE_DURATION = 280;
const ROTATE_BEARING_STEP_DEG = 30;
const TILT_STEP_DEG = 15;

// Pitch bounds in world degrees, derived from the polar limits set above.
const MIN_PITCH_DEG = 90 - THREE.MathUtils.radToDeg(controls.maxPolarAngle);
const MAX_PITCH_DEG = 90 - THREE.MathUtils.radToDeg(controls.minPolarAngle);

// One tweens-in-flight record per axis: { frame, target }.
const animationState = { bearing: null, pitch: null };

function currentBearingDeg() {
  const azimuthDeg = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
  return ((180 - azimuthDeg + 540) % 360) - 180;
}

function currentPitchDeg() {
  return 90 - THREE.MathUtils.radToDeg(controls.getPolarAngle());
}

// Rotates the camera about the target by delta radians of azimuth. Positive
// delta turns the view clockwise on screen, which lowers the bearing.
function setCameraAzimuth(delta) {
  const offset = camera.position.clone().sub(controls.target);
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  camera.position.set(
    controls.target.x + offset.x * cos + offset.z * sin,
    controls.target.y + offset.y,
    controls.target.z - offset.x * sin + offset.z * cos,
  );
  camera.lookAt(controls.target);
  controls.update();
}

// Poses the camera at an absolute pitch, keeping the current bearing and the
// distance to the target. The horizontal offset is scaled by the ratio the new
// polar angle needs; at pitch 90 that ratio is 0, which is fine as long as
// something else has already fixed the bearing (see the polar limits above).
function setCameraPitch(deg) {
  const offset = camera.position.clone().sub(controls.target);
  const radius = offset.length();
  const horizontal = Math.hypot(offset.x, offset.z);
  const polar = THREE.MathUtils.degToRad(90 - deg);
  const scale = horizontal > 1e-6 ? (Math.sin(polar) * radius) / horizontal : 0;
  camera.position.set(
    controls.target.x + offset.x * scale,
    controls.target.y + Math.cos(polar) * radius,
    controls.target.z + offset.z * scale,
  );
  camera.lookAt(controls.target);
  controls.update();
}

// Next value for a stepped axis, snapping onto the `step` grid.
//
// The rule that makes the buttons feel right: a view resting exactly on a grid
// line moves one whole step, but one resting *between* lines (a drag left it at
// 29 degrees, or a limit pinned it at 90) first snaps onto the nearest line
// instead of jumping a full step past it. Hence "press at 29 degrees -> 30".
//
// `animationState[axis].target` is where the current tween is heading (or null),
// so repeated presses queue up: base the step on that rather than on the camera's
// in-flight angle. A target clamped by a limit is never actually reachable,
// though, so only reuse it while it sits within the bounds; otherwise fall back to
// the real angle or the buttons would jam against the limit.
//
// `min`/`max` are optional: the bearing wraps freely, only the pitch is bounded.
function stepTarget(axis, current, step, direction, min, max) {
  const pending = animationState[axis]?.target;
  const pendingUsable =
    pending != null &&
    (min === undefined || pending >= min) &&
    (max === undefined || pending <= max);
  const base = pendingUsable ? pending : current;

  const nearest = Math.round(base / step) * step;
  const onGrid = Math.abs(base - nearest) < 1e-3;
  // Snap onto the nearest grid line, which is what makes "press at 29 -> 30"
  // work. Near a limit the nearest line can fall outside the bounds though
  // (pitch 1 has 0 as its nearest line), and clamping it back would turn the
  // press into a no-op, so fall back to the next line inside the bounds.
  const inBounds = (v) =>
    (min === undefined || v >= min) && (max === undefined || v <= max);
  let wanted;
  if (onGrid) {
    wanted = nearest + direction * step;
  } else if (inBounds(nearest)) {
    wanted = nearest;
  } else {
    wanted =
      direction > 0
        ? (Math.floor(base / step) + 1) * step
        : (Math.ceil(base / step) - 1) * step;
  }
  if (min === undefined && max === undefined) return wanted;
  return THREE.MathUtils.clamp(wanted, min, max);
}

// Tween a single axis from `from` to `to`, calling apply(value) each frame with
// an ease-out cubic. Only one tween per axis runs at a time; a new press
// cancels the previous frame loop and starts from the camera's current angle.
function animateStep(axis, from, to, apply) {
  if (animationState[axis]) cancelAnimationFrame(animationState[axis].frame);
  const startedAt = performance.now();
  const tick = (now) => {
    const t = Math.min((now - startedAt) / ROTATE_DURATION, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    apply(from + (to - from) * eased);
    animationState[axis] =
      t < 1 ? { frame: requestAnimationFrame(tick), target: to } : null;
  };
  animationState[axis] = { frame: requestAnimationFrame(tick), target: to };
}

// Tweens the bearing from its current angle to an absolute value. The target is
// a bearing (not a wrapped azimuth), so 0 is north and the tween always takes
// the short way round because bearings live in -180..180.
function animateBearingTo(target) {
  const start = currentBearingDeg();
  animateStep('bearing', start, target, (desired) => {
    // Turn by the remaining bearing error, converted back to an azimuth delta.
    const delta = desired - currentBearingDeg();
    if (delta !== 0) setCameraAzimuth(-THREE.MathUtils.degToRad(delta));
  });
}

function rotateByStep(direction) {
  const start = currentBearingDeg();
  // Rotate right lowers the bearing, hence the negated direction.
  const target = stepTarget('bearing', start, ROTATE_BEARING_STEP_DEG, -direction);
  animateBearingTo(target);
}

function tiltByStep(direction) {
  const start = currentPitchDeg();
  const target = stepTarget(
    'pitch',
    start,
    TILT_STEP_DEG,
    direction,
    MIN_PITCH_DEG,
    MAX_PITCH_DEG,
  );
  animateStep('pitch', start, target, setCameraPitch);
}

for (const [id, direction] of [
  ['rotate-left', -1],
  ['rotate-right', 1],
]) {
  const button = document.getElementById(id);
  if (button) {
    button.addEventListener('click', () => rotateByStep(direction));
  }
}

for (const [id, direction] of [
  ['tilt-up', 1],
  ['tilt-down', -1],
]) {
  const button = document.getElementById(id);
  if (button) {
    button.addEventListener('click', () => tiltByStep(direction));
  }
}

const northButton = document.getElementById('north');
if (northButton) {
  northButton.addEventListener('click', () => {
    // Toggle: from any other bearing go to north (0), and when already there
    // return to the map's default bearing. Using the in-flight tween target
    // keeps a rapid second press from re-reading a mid-turn angle.
    const angle = animationState.bearing?.target ?? currentBearingDeg();
    const isNorth = Math.abs(angle) < 0.5;
    animateBearingTo(isNorth ? DEFAULT_BEARING : 0);
  });
}

const clayMaterial = new THREE.MeshLambertMaterial({
  color: 0xfafafa,
});

const coverageUniforms = {
  coverageMap: { value: coverageTarget.texture },
  coverageTransform: { value: coverageMatrix },
  coverageEnabled: { value: 0 },
  coverageMax: { value: MAX_SHADOW_OVERLAP },
};

clayMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.coverageMap = coverageUniforms.coverageMap;
  shader.uniforms.coverageTransform = coverageUniforms.coverageTransform;
  shader.uniforms.coverageEnabled = coverageUniforms.coverageEnabled;
  shader.uniforms.coverageMax = coverageUniforms.coverageMax;

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec3 vCoverageWorld;`,
    )
    .replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vCoverageWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      uniform sampler2D coverageMap;
      uniform mat4 coverageTransform;
      uniform float coverageEnabled;
      uniform float coverageMax;
      varying vec3 vCoverageWorld;

      float coverageOverlap() {
        if ( coverageEnabled < 0.5 ) return 0.0;
        vec4 shadowSpace = coverageTransform * vec4( vCoverageWorld, 1.0 );
        vec3 ndc = shadowSpace.xyz / shadowSpace.w;
        vec2 uv = ndc.xy * 0.5 + 0.5;
        if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return 0.0;
        float raw = texture2D( coverageMap, uv ).r * 255.0;
        return clamp( floor( raw + 0.5 ) - 1.0, 0.0, coverageMax - 1.0 ) / ( coverageMax - 1.0 );
      }`,
    )
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        float cov = mix( 1.0, 0.72, coverageOverlap() );
        reflectedLight.directDiffuse *= cov;
        reflectedLight.indirectDiffuse *= cov;
        float baseShade = mix(
          ${CLAY_BASE_SHADE.toFixed(3)},
          1.0,
          smoothstep( 0.0, ${CLAY_BASE_SHADE_HEIGHT.toFixed(1)}, vCoverageWorld.y )
        );
        reflectedLight.directDiffuse *= baseShade;
        reflectedLight.indirectDiffuse *= baseShade;
      }`,
    );
};
clayMaterial.customProgramCacheKey = () => 'om3d-clay-coverage';

async function createClayMaterial() {
  if (!isWebGPU) return clayMaterial;

  const { MeshLambertNodeMaterial, PhongLightingModel } = await import(
    'three/webgpu'
  );
  const TSL = await import('three/tsl');

  const material = new MeshLambertNodeMaterial({ color: 0xfafafa });

  const coverageTexture = TSL.texture(
    coverageTarget.texture,
    TSL.vec2(0, 0),
  );
  const coverageMatrixNode = TSL.uniform(coverageMatrix);
  const coverageEnabledNode = TSL.uniform(0);
  const coverageMaxNode = TSL.uniform(MAX_SHADOW_OVERLAP);

  const coverageFactor = TSL.Fn(() => {
    const clip = coverageMatrixNode.mul(TSL.vec4(TSL.positionWorld, 1));
    const ndc = clip.xyz.div(clip.w);
    const sampleUV = ndc.xy.mul(0.5).add(0.5);
    const raw = coverageTexture.sample(sampleUV).r.mul(255).add(0.5).floor();
    const overlaps = TSL.clamp(raw.sub(1), 0, coverageMaxNode.sub(1));
    const inside = sampleUV.x
      .greaterThanEqual(0)
      .and(sampleUV.x.lessThanEqual(1))
      .and(sampleUV.y.greaterThanEqual(0))
      .and(sampleUV.y.lessThanEqual(1));
    return TSL.select(
      inside.and(coverageEnabledNode.greaterThan(0.5)),
      overlaps.div(coverageMaxNode.sub(1)),
      TSL.float(0),
    );
  })();

  class CoverageLightingModel extends PhongLightingModel {
    constructor() {
      super(false);
    }

    finish(builder) {
      const { outgoingLight } = builder.context;
      outgoingLight.rgb.mulAssign(
        TSL.mix(TSL.float(1), TSL.float(0.72), coverageFactor),
      );
      const baseShade = TSL.mix(
        TSL.float(CLAY_BASE_SHADE),
        TSL.float(1),
        TSL.smoothstep(
          TSL.float(0),
          TSL.float(CLAY_BASE_SHADE_HEIGHT),
          TSL.positionWorld.y,
        ),
      );
      outgoingLight.rgb.mulAssign(baseShade);
    }
  }

  material.setupLightingModel = () => new CoverageLightingModel();
  material.userData.coverageEnabledNode = coverageEnabledNode;

  return material;
}

let activeClayMaterial = clayMaterial;
let tilesLoadedTotal = 0;
let tilesDisposedTotal = 0;

function setClayMaterialForAll() {
  if (!tiles) return;
  tiles.group.traverse((child) => {
    if (child.isMesh && child.material !== activeClayMaterial) {
      child.material = activeClayMaterial;
    }
  });
}

function applyTilesMaterial(scene) {
  scene.traverse((child) => {
    if (child.isMesh) {
      child.material = activeClayMaterial;
      child.castShadow = shadowsEnabled;
      child.receiveShadow = shadowsEnabled;
    }
  });
  if (shadowsEnabled) {
    shadowDirty = true;
  }
}

function refreshTilesShadowFlags() {
  if (!tiles) return;
  tiles.group.traverse((child) => {
    if (!child.isMesh) return;
    if (child.castShadow !== shadowsEnabled) {
      child.castShadow = shadowsEnabled;
      child.receiveShadow = shadowsEnabled;
    }
  });
}

function createTilesRenderer(url) {
  const tilesRenderer = new TilesRenderer(url);
  tilesRenderer.registerPlugin(
    new GLTFExtensionsPlugin({ meshoptDecoder: MeshoptDecoder }),
  );
  tilesRenderer.registerPlugin(
    new ReorientationPlugin({
      lat: THREE.MathUtils.degToRad(CENTER.lat),
      lon: THREE.MathUtils.degToRad(CENTER.lon),
      recenter: true,
    }),
  );
  tilesRenderer.errorTarget = qualityConfig.errorTarget;
  tilesRenderer.lruCache.minSize = qualityConfig.lruMinItems;
  tilesRenderer.lruCache.maxSize = qualityConfig.lruMaxItems;
  tilesRenderer.lruCache.minBytesSize = qualityConfig.lruMinBytes;
  tilesRenderer.lruCache.maxBytesSize = qualityConfig.lruMaxBytes;
  tilesRenderer.maxTilesProcessed = qualityConfig.maxTilesProcessed;
  tilesRenderer.displayActiveTiles =
    shadowsEnabled && qualityTier !== 'low';
  tilesRenderer.autoDisableRendererCulling = false;

  // The water reflection is rendered from a camera mirrored about the water
  // plane, so it shows geometry the main camera has culled. Those tiles are
  // detached from the tiles group by the traversal and never reach the mirror
  // render, which is why tall buildings lost their reflection when zooming in.
  // Force every tile within WATER_REFLECTION_KEEP_RADIUS of the view target to
  // stay in view: the base error is preserved, so LOD is unchanged, and the
  // meshes keep `frustumCulled`, so off-screen ones still cost nothing in the
  // main pass but are available to the mirror pass.
  if (qualityConfig.waterReflection) {
    const keepSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    const keepCenter = new THREE.Vector3();
    const baseCalculateTileViewError =
      tilesRenderer.calculateTileViewError.bind(tilesRenderer);
    tilesRenderer.calculateTileViewError = (tile, target) => {
      baseCalculateTileViewError(tile, target);
      if (target.inView) return;

      const boundingVolume = tile.engineData?.boundingVolume;
      if (!boundingVolume) return;

      // Tile bounding volumes are in the tiles group's local space, while the
      // view target is in world space.
      keepCenter
        .set(controls.target.x, 0, controls.target.z)
        .applyMatrix4(tilesRenderer.group.matrixWorldInverse);
      keepSphere.center.copy(keepCenter);
      keepSphere.radius = WATER_REFLECTION_KEEP_RADIUS;
      if (boundingVolume.intersectsSphere(keepSphere)) {
        target.inView = true;
      }
    };
  }

  tilesRenderer.setCamera(camera);
  const resolution = new THREE.Vector2();
  renderer.getSize(resolution).multiplyScalar(renderer.getPixelRatio());
  tilesRenderer.setResolution(camera, resolution);
  tilesRenderer.addEventListener('load-model', ({ scene: tileScene }) => {
    tilesLoadedTotal++;
    applyTilesMaterial(tileScene);
    aoDirty = true;
    if (shadowsEnabled) shadowDirty = true;
  });
  tilesRenderer.addEventListener('dispose-model', () => {
    tilesDisposedTotal++;
    aoDirty = true;
    if (shadowsEnabled) shadowDirty = true;
  });
  tilesRenderer.addEventListener('tile-visibility-change', ({ tile }) => {
    if (tile?.engineData?.scene) {
      applyTilesMaterial(tile.engineData.scene);
    }
    aoDirty = true;
    if (shadowsEnabled) shadowDirty = true;
  });
  tilesRenderer.forEachLoadedModel((tileScene) => {
    applyTilesMaterial(tileScene);
  });
  const tilesGroup = new THREE.Group();
  tilesGroup.add(tilesRenderer.group);
  scene.add(tilesGroup);
  return tilesRenderer;
}

const tileResolution = new THREE.Vector2();

function updateTilesResolution() {
  if (!tiles) return;
  renderer.getSize(tileResolution);
  tileResolution.multiplyScalar(renderer.getPixelRatio());
  tiles.setResolution(camera, tileResolution);
}

function onResize() {
  const nextAspect = window.innerWidth / window.innerHeight;
  camera.left = (-VIEW_SIZE * nextAspect) / 2;
  camera.right = (VIEW_SIZE * nextAspect) / 2;
  camera.top = VIEW_SIZE / 2;
  camera.bottom = -VIEW_SIZE / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  updateTiltShiftResolution();
  updateTilesResolution();
  aoDirty = true;
}

window.addEventListener('resize', onResize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateShadowCamera();
  updateFog();
  camera.updateMatrixWorld();
  updateSky();
  updateSkyGlowPosition();
  // AO is a screen-space effect: it only changes when the view changes. This
  // also covers the intro animation and the reset buttons, which do not emit
  // controls change events.
  if (camera.zoom !== aoViewZoom || !aoViewMatrix.equals(camera.matrixWorld)) {
    aoViewMatrix.copy(camera.matrixWorld);
    aoViewZoom = camera.zoom;
    aoDirty = true;
  }
  northArrowEl.style.transform = `rotate(${controls.getAzimuthalAngle() - Math.PI}rad)`;
  updateBasemap();

  const show3D = !!tiles && camera.zoom >= 0.25;
  if (tiles) {
    tiles.group.visible = show3D;
    if (show3D) {
      tiles.errorTarget = basemapMoving
        ? qualityConfig.errorTargetMoving
        : qualityConfig.errorTarget;
      tiles.setCamera(camera);
      updateTilesResolution();
      tiles.update();
    }
  }

  // On low, shadows are hidden while the camera moves so no shadow or
  // coverage pass runs during a pan. The map is rebuilt once after the idle
  // timer clears `basemapMoving` (which also sets `shadowDirty`).
  const shadowsPaused = isShadowPaused();
  if (shadowsEnabled) {
    sun.shadow.intensity = shadowsPaused ? 0 : SHADOW_INTENSITY;
  }
  if (shadowGround) {
    shadowGround.visible = shadowsEnabled && !shadowsPaused;
  }

  if (shadowsEnabled && shadowDirty && !shadowsPaused) {
    renderer.shadowMap.needsUpdate = true;
    if (isCoverageEnabled()) renderCoverage();
    shadowDirty = false;
  }

  if (gpuWaterReflection) {
    water?.updateMatrixWorld();
    // The reflection is blurred; refreshing every other frame is invisible and
    // saves a full extra scene render on the skipped frames.
    if ((waterReflectionFrame++ & 1) === 0) {
      renderGPUWaterReflection();
    }
  }

  const frameAspect = window.innerWidth / window.innerHeight;
  updateTiltShiftStrength();
  updateAOStrength();
  aoUpdateThisFrame = aoStrength > 0.001 && aoDirty;
  if (aoBlurNode) aoBlurNode.textureNeedsUpdate = aoUpdateThisFrame;
  if (tiltShiftPass) {
    tiltShiftPass.uniforms.aspect.value = frameAspect;
  }
  if (frameAspectNode) frameAspectNode.value = frameAspect;

  const usePost =
    (aoEnabled && aoStrength > 0.001) || tiltShiftStrength > 0.0001;
  if (usePost && composer) {
    composer.render();
  } else if (usePost && renderPipeline) {
    renderPipeline.render();
  } else {
    renderer.render(scene, camera);
  }
  if (aoUpdateThisFrame) aoDirty = false;
}

activeClayMaterial = await createClayMaterial();
setClayMaterialForAll();

createWater();
setShadows(shadowsEnabled);
animate();
