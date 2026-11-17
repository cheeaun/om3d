# AGENTS.md

Context for coding agents working on this repository.

## Stack

- Vite 8 (requires Node.js 24; CI uses Node 24)
- three 0.187 (`OrthographicCamera`, `MapControls`, `WebGLRenderer`, optional
  `WebGPURenderer`)
- 3d-tiles-renderer 0.5 (`TilesRenderer`, `GLTFExtensionsPlugin`,
  `ReorientationPlugin`)
- loaders.gl 4.5 (`Tiles3DLoader`, `DracoLoader`) for the tile scripts
- OpenFreeMap vector basemap (OpenMapTiles schema) rasterized into a shared
  canvas and uploaded as `ImageBitmap` tile textures; no API key required
- MapLibre GL JS (`maplibre-gl`) drives only the `/export/` page's 2D map, for
  building footprints and labels; the main page does not load it
- `gltfpack` (dev dependency) and `meshoptimizer` are used by
  `build-toy-tiles` for per-building simplification and meshopt compression

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server on http://localhost:5931 |
| `npm run build` | Production build into `dist/` |
| `npm run serve` | Preview the build on http://localhost:5932 |
| `npm run fetch-tiles` | Download tiles from OneMap into `tiles/` |
| `npm run retry-tiles` | Retry URIs listed in `<output>/failures.txt` |
| `npm run build-toy-tiles` | Build the simplified `optimized-tiles/` |

Ports are deliberately fixed to 5931/5932 with `strictPort: true`. Do not
change them to Vite defaults; the machine running this repo has other projects
on the usual ports, and a silent fallback would be worse than a hard failure.
Both servers set `host: true` on purpose so a phone on the same network can
open the dev build; keep that when editing the config, and do not expose them
outside a trusted network.

`postbuild` runs `scripts/copy-tiles.mjs`, which copies only `tileset.json` and
`*.b3dm` into `dist/optimized-tiles`. Do not copy the whole directory: the old
pipeline left ~808 MB of intermediate GLBs behind.

For browser testing use `agent-browser`, not Safari/WebDriver automation. Safari
launched for automation ends up backgrounded (`document.visibilityState` is
`hidden`), so `requestAnimationFrame` never runs, the render loop stalls, and no
tiles load — which makes on-screen verification impossible.

## Key files

- `main.js` — Three.js scene, orthographic camera, OpenFreeMap basemap,
  `TilesRenderer`, start gate, shadows toggle, compass reset, stepped
  rotate/tilt buttons
- `index.html` — canvas host, start overlay, settings button plus the grouped
  compass/rotate and tilt pill buttons, panels, attribution
- `style.css` — app and overlay styles
- `vite.config.js` — base path and fixed dev/preview ports
- `webgl-water.js` — fork of the addon `Water` with a configurable Fresnel
  reflectivity and screen-space reflection sampling
- `webgpu-water.js` — fork of the addon `WaterMesh` with a configurable
  reflectivity, sampling the target rendered by `renderGPUWaterReflection()`
- `scripts/fetch-tiles.mjs` — concurrent downloader with retries and optional
  in-memory texture stripping
- `scripts/strip-b3dm.mjs` — shared B3DM texture stripper used by fetch/retry
- `scripts/retry-failed-tiles.mjs` — retries the URIs in `failures.txt`
- `scripts/build-toy-tiles.mjs` — depth-8 selection plus per-batch mesh
  simplification into `optimized-tiles/`
- `scripts/build-toy-tiles-all.mjs` — runs the builder in 500-tile child
  processes because the Draco/meshoptimizer WASM heap grows over a full run
- `scripts/copy-tiles.mjs` — deployment payload filter
- `export/` — second, standalone entry point (`/export/`): MapLibre map,
  polygon editor, three.js preview, STL/GLB/glTF download. See below.

## Rendering notes

- **The render loop is on demand, not free-running.** `animate()` still requests
  every frame, but returns early unless there is something to draw: the camera
  moved (`controls.update()` returns `true` while damping/inertia eases), a setter
  called `requestFrame()`, tiles or basemap textures are in flight, a shadow map
  is dirty and not move-paused, or the lighting fade is running. There is no
  ambient animation, so a parked view draws zero frames — that is the intended
  behaviour, not a stall. Anything that changes the canvas outside a camera move
  **must** call `requestFrame()` or it will not appear until the next pan. This
  is wired for tile `needs-update`/`load-model`/`dispose-model`/
  `tile-visibility-change`, basemap arrival and level cleanup, the tilejson
  retry, `applyLighting()`, `setShadows`, `setTiltShift`, `applyQuality`, `start`,
  `onResize`, the 180 ms move-idle timer and the `controls` `change` event. Do
  not add an animation that relies on the loop running while idle.
  `om3dMemory().view.framesDrawn` / `framesSkipped` prove it either way.
- Three traps in that gate, each of which broke it once: `aoDirty` cannot be a
  reason to draw (with AO off it is never consumed, so the loop would never park);
  `stats.loaded` is the resident tile count and never returns to zero, so only
  `queued + downloading + parsing` mean busy; and the root `tileset.json` fetch is
  invisible in `stats`, so `3d-tiles-renderer`'s `needs-update` event is what
  restarts the loop after it parks — without it the 3D layer never starts.
- Tile LOD needs no relaxation layer, and adding one is wasted work. Under this
  orthographic camera `3d-tiles-renderer` computes a tile's error as
  `geometricError / pixelSize` with `distanceFromCamera = Infinity`
  (`TilesRenderer.js` `calculateTileViewError`), so Cesium-style distance-based
  screen-space-error relaxation (`dynamicScreenSpaceError`, Navara's `lodFog`)
  has nothing to act on. And `pixelSize` comes from the projection matrix
  (`2 / projection[0]`, `2 / projection[5]`), which already includes
  `camera.zoom`, so zooming out coarsens LOD by itself. A pitch-relaxed
  `errorTarget` was measured (1.8x moved 121 -> 119 visible tiles; 4x reached
  105 but looked visibly coarser) and reverted. Tilted views do hold more tiles
  (69 -> 121 from pitch 45 to 15) because the frustum footprint really grows,
  not because the LOD is wrong.
- The camera is orthographic. Its `camera.zoom` is not Mapbox zoom: initial
  zoom `2` ≈ Mapbox z16.5, and `maxZoom = 91` ≈ z22. Keep that mapping when
  adjusting framing.
- `MapControls` pans 1:1 with inertia after release. Ctrl/meta/shift + left or
  right-drag rotates with damping disabled during the drag, then restores it.
- Touch is a custom MapLibre-style layer, not OrbitControls' built-in touch
  path: `controls.touches.TWO` is `null` so MapControls only handles the
  one-finger pan. Two fingers pan by centroid, pinch to zoom, twist to
  bearing, and drag vertically with side-by-side (never stacked) fingers to
  tilt. Each gesture pins its first two fingers, so extra fingers are ignored
  and the mode (pitch vs. free) is decided once per gesture.
- Pointer events carry one finger at a time, unlike the `TouchEvent` MapLibre's
  handlers consume. Gesture work is therefore batched into one update per
  animation frame, and pitch recognition is judged on each finger's cumulative
  travel since the gesture started. Doing either per-event breaks tilt and makes
  pinch zoom jitter.
- The basemap is a grid of 512 px tiles rendered from OpenFreeMap vector
  tiles, sized to the visible ground footprint (from the camera frustum). Every
  tile draws into one shared 512 canvas and is snapshotted with
  `createImageBitmap`; never allocate a canvas per tile. A Mobile Safari session
  created 468 canvases (~468 MB) before this and crashed the tab.
  `ImageBitmap.close()` runs on dispose. A promise lock serializes the draw +
  snapshot so another tile cannot overwrite the shared canvas in between.
  Supersampled tiles use one shared scratch canvas per size (1024 / 2048), not a
  new canvas per tile. `renderVectorTile` must clear the shared target before
  the downscale blit; otherwise the previous tile's land shows through the
  current tile's transparent water holes.
- The tile range is derived from that footprint and the zoom is reduced as
  needed so the range stays within `qualityConfig.basemapMaxTiles`; the desired
  zoom follows the camera and is clamped at z22. The basemap LOD never increases
  while moving and is rebuilt after 180 ms idle. Loads go through
  `basemapTileQueue` with `qualityConfig.basemapMaxActiveLoads` (2 low / 5
  medium / 10 high). Tiles whose mesh or level token is gone after the fetch are
  skipped before rasterizing. The previous level is removed when the new level
  finishes, or after `qualityConfig.basemapCleanupDelay` (500 / 1200 / 2000 ms).
  Every level sits at the same world Y and levels are ordered with
  `mesh.renderOrder` (`-100 + zoom`); do not move the old level to hide
  z-fighting, because a 0.5-unit shift is a visible wobble at high zoom.
- Vector tiles are drawn at one canvas pixel per source unit whenever possible.
  Below that ratio Safari's canvas renders thin polylines as separate
  round-capped segments (visible as disjointed roads), so `renderVectorTile`
  supersamples to up to 2048 px and downscales to the tile texture when
  `pixelsPerUnit < 1`. Keep this when changing canvas sizes or zoom caps.
- Do not use `context.clip(Path2D)` for the Singapore outline: Safari's clip
  drops chunks out of thick road strokes. `renderVectorTile` draws unclipped
  and masks the finished tile with `destination-in`; everything outside the
  outline stays transparent so the reflective water plane shows through.
  Basemap textures also skip mipmaps (`LinearFilter`); the tiles stay close to
  1:1, and linear sampling avoids Safari's mip-based stroke erosion while
  saving 25% texture memory.
- The full `optimized-tiles/tileset.json` is loaded through `TilesRenderer`
  with the tier's `errorTarget`, tile cache, and a start gate so no tiles load
  behind the intro overlay.
- Tone mapping is `NeutralToneMapping` at exposure 1.22, applied by
  `OutputPass` on WebGL and by the `RenderPipeline` output transform on WebGPU.
  Do not switch back to `NoToneMapping`: the white model clips without it.
  `AgXToneMapping` was tested and rejected because it caps whites near 0.85.
- Lighting is a near-neutral key (`sun`, `0xfffdfa` at 4.7) plus a neutral
  fill (`0xfffdfb` at 0.14) and a bright neutral hemisphere (`0xffffff` sky /
  `0xe8e9e9` ground at 1.15). Keep the flat-look tints neutral rather than warm;
  a cool hemisphere ground puts a blue glow under the buildings. When shadows
  are on the hemisphere drops to `0.7` and its ground is tinted slightly warm
  (`0xebe8e2`) so the indirect fill does not read blue against the warm key.
  The clay is a neutral off-white Lambert (`0xfafafa`); the basemap keeps its
  own land-cover colours (grass/wood/sand/landuse/roads via
  `vectorFeatureColor`), and the lighting multiplies over them so parks stay
  green while the map absorbs the time-of-day tint. Keep the model brighter
  than the base; if the model looks "cloudy", check exposure and the base
  values before adding contrast.
- Time-of-day lighting is opt-in through the `#lighting` checkbox (off by
  default) and works with or without shadows. `LIGHTING_COLOR_STOPS` /
  `LIGHTING_SCALAR_STOPS` key on the slider's true solar elevation, not clock
  time, so dawn and dusk share the same warm-key/cool-sky curve; `DUSK_*` adds
  a small rose tint on the evening side. Singapore is equatorial and humid, so
  the warm band is short, the sky stays hazy instead of saturated, and the
  skylight stays cool while the key is warm. `LIGHTING_BASE` holds the flat
  values, and `applyLighting()` lerps over them with `lightingBlend`, which
  tweens on toggle but tracks the slider directly. Without shadows only the
  preset colours are taken: the shadowed preset's heavy key / thin fill would
  wash out a shadowless scene, so `applyLighting()` keeps the flat intensities
  and exposure when `shadowsEnabled` is false. At high sun the tint is white
  and the colours match the flat day look except for the sky gradient.
  Keep the basemap tint (`basemapTint`) and water `sunColor`/`waterColor` in
  sync with the preset: the basemap and ground are unlit and can only be
  tinted, and water is a shader the lights do not reach. `basemap` stops are
  multipliers over the baked layer colours, with white at high sun (natural
  colours) and a warm darkening at dawn/dusk; `LIGHTING_BASE_BASEMAP` is white.
  `applyLighting()` only walks the basemap meshes that exist when the preset
  changes, so the basemap tile loader must copy `basemapTint` into each new
  material when its texture arrives; otherwise a level that finishes loading
  later comes in white and the land looks unlit until the next lighting change.
  `sky` is the horizon/fog colour and `skyTop` is the zenith colour for the sky
  gradient. `?lighting=1` enables it at startup (works with or without
  `?shadows=1`).
- The sky above the map is a gradient plane (`skyPlane`), not a dome: an
  orthographic camera has no horizon, so `updateSky()` fits a camera-facing
  plane to the strip between the camera far plane's screen row and the top of
  the view. Its bottom colour is the fog colour, so the horizon seam is
  invisible; `skyTop` supplies the zenith colour and
  `updateSkyGradientTexture()` redraws the 256x128 canvas whenever the colours or
  the sun glow change. It is on layer 2 (main view only). The sun panel's
  LABEL (`#sun-phase`) shows Dawn/Day/Dusk while lighting is on and goes back to
  `Sun` when it is off.
- The sun is not a mesh: its glow is painted into the sky gradient canvas, so it
  is part of the background and anything drawn later covers it. That is what
  makes it impossible for the sun to show through a building, and it is why
  nothing is drawn when the sky band is hidden. `updateSkyGlowPosition()` maps the
  sun's azimuth relative to `cameraForward` to the glow's X and its elevation to
  Y, fading out past ±32° of relative azimuth (`SKY_GLOW_HALF_ANGLE`). It is
  deliberately a broad low-contrast haze with no bright core: an orthographic
  camera has zero parallax, so a direction cannot move on screen while panning.
  A crisp disc then reads as a decal pinned to the glass next to sliding
  buildings, while diffuse haze reads as light in the air. Do not "fix" the
  pinned sun by world-anchoring it — a fixed compass bearing must not drift as
  you pan. The glow is additive (`globalCompositeOperation = 'lighter'`) in the
  2D canvas, so both renderers get an identical result. `skyGlowAspect` squashes
  it by the band's own aspect so it stays round once the strip is stretched.
- Shadows are opt-in through the `#shadows` button. Medium/high use
  `PCFShadowMap`; low uses `BasicShadowMap` (one compare instead of PCF's
  multi-tap filter) because pausing shadows only zeroes the intensity uniform,
  not the sampling. Shadow map size follows the tier (1024 / 2048 / 4096) and a
  tinted `ShadowMaterial` catcher receives the shadows.
  `SHADOW_INTENSITY` is 1, so cast shadows are fully dark for shadow analysis.
  `SHADOW_CATCHER_OPACITY` is tuned per backend (`0.56` WebGL, `0.7` WebGPU)
  because the node renderer blends differently. Hemisphere and fill light drop
  when shadows are on (`0.7` / `0.14`) so shadowed faces do not wash out with a
  bright, blue-looking glow at low sun.
  Keep the catcher tint neutral cool (`0x4a515a`); pure black shadows look like
  soot, not plaster.
- Low pauses shadows while `basemapMoving`: it sets `sun.shadow.intensity = 0`,
  hides the catcher, and skips both the shadow-map and coverage passes. The idle
  timer restores them and marks `shadowDirty`. Low also disables the coverage
  pass and `displayActiveTiles`; medium/high keep both.
- **Streaming shadow rebuilds are coalesced, and that coalescing is deliberate.**
  Tile loading, visibility changes and dispose events all set `shadowDirty`, so
  unthrottled this re-rendered the 10 km shadow map plus the coverage pass on
  almost every frame of a pan: measured **81 rebuilds over 110 drawn frames**.
  `canRebuildShadows()` now limits rebuilds to one per
  `SHADOW_STREAM_INTERVAL_MS` (200 ms) **only while `isStreamingActive()`**,
  which took it to 20 and still converges to `shadowDirty === false` once tiles
  settle. Two rules must be kept: a moved shadow camera (`shadowCameraMoved`,
  set by `updateShadowCamera()` when the sun or the snapped focus changes) must
  **always** bypass the throttle, because the map is sampled relative to the sun
  camera and a delayed rebuild leaves shadows offset from their geometry; and a
  low-tier move pause still wins over both. `om3dMemory().view.shadowRebuilds`
  counts them, so any regression here is visible.
- Anti-aliasing is 4x MSAA on both renderer paths. `antialias: true` covers the
  direct canvas render (low quality); the WebGL `EffectComposer` gets an
  explicit `HalfFloatType` target with `samples: 4`, and the WebGPU `pass()`
  gets `{ samples: 4 }` so its color/depth targets match. Do not disable these:
  the white clay silhouettes alias badly against the flat basemap.
- Ambient occlusion is GTAO on both paths: `GTAOPass` before tilt shift on
  WebGL, `GTAONode` on WebGPU. Both share `AO_RADIUS` (12), `AO_THICKNESS` (22),
  `AO_SAMPLES` (8), and scale `AO_SCALE` (1.3), blended at `AO_BLEND` (0.8).
  The tight radius is what makes adjacent buildings read apart: it only darkens
  where another building is within ~12 world units, so open edges over grass or
  water stay clean. `low` turns AO off; `medium` and `high` run GTAO at half
  resolution (`qualityConfig.aoScale`) on both paths — `GTAONode.resolutionScale`
  on WebGPU, and WebGL wraps `GTAOPass.setSize()` to shrink its G-buffer/AO/
  denoise targets while the final copy/blend stays full size. On WebGPU the raw
  GTAO output is blurred once per update into an AO-resolution RTT (`aoBlurNode`,
  3x3 taps, 2.5 AO texels) and sampled once per fragment; blurring in the
  lighting shader would cost 9 fetches per lit pixel. `DenoiseNode` and
  `TRAANode` are not used: the former samples depth that is a render attachment
  in this pass (WebGPU validation error), the latter needs a velocity buffer and
  temporal history. The thickness is in world units. `?ao=0` disables it.
- On WebGPU the AO sample must be applied through `scenePass.contextNode =
  builtinAOContext(...)`, not by multiplying it into the render pipeline output.
  Sampling the AO pass texture in the output pass draws a soft white halo along
  geometry edges (the MSAA resolve interacts badly with the extra pass). The
  context path feeds AO into the lighting model's indirect term instead, so it
  also no longer darkens direct sunlight. `setAOEnabled()` swaps the context
  node and bumps `webgpuScenePass.version` so the material shaders rebuild.
- AO is only recomputed when the view or tile geometry changes: `animate()`
  sets `aoDirty` from `camera.matrixWorld`/`camera.zoom` and tile load events.
  On WebGL the pass replays its cached AO via the copy + blend branch; on WebGPU
  `GTAONode.updateBefore` and the blur RTT update are skipped, so the cached
  texture is reused. `aoStrength` fades AO out below zoom 3.2 (full at 5) and
  near top-down (full at 70° elevation, 0 at 85°); at zero strength the pass is
  disabled and the composer/pipeline is skipped entirely.
- The clay `coverageOverlap()` darkening is intentionally light (`0.72`); real
  AO now handles contact shading, and strong overlap darkening reads as dirt.
- The clay also has a soft contact shade at ground level: `CLAY_BASE_SHADE`
  (0.85) fades to 1 over `CLAY_BASE_SHADE_HEIGHT` (6 world units) of world Y,
  on both shader paths. It grounds the buildings the way Apple Maps does.
  Keep it low-contrast; it is not a replacement for AO.
- Reflective water sits effectively at land level: `WATER_Y` is only
  `WATER_DEPTH` (0.1) below `LAND_Y`, with no basement walls. `renderVectorTile`
  erases the `water`/`waterway` layers with `destination-out` and the basemap
  material uses `alphaTest: 0.5`, so the water plane shows through the holes.
  This is a planar reflection, not SSR: the water renders the scene from a
  mirrored camera into a small render target, and the material looks it up in
  screen space. Both renderers use local forks (`webgl-water.js`,
  `webgpu-water.js`) because the addons' oblique near-plane clipping is invalid
  for this orthographic camera. Sample with screen X flipped and Y unflipped.
  WebGPU renders its mirror view in `renderGPUWaterReflection()` before the main
  pass. A static value-noise normal map displaces the lookup (stretched/squeezed
  reflection plus sun specular, `distortionScale` 5, `WATER_REFLECTIVITY` 0.35)
  and a 9-tap vertical kernel smears it down the screen, so the reflection is
  soft and blurry; do not animate it. The reflection target is small —
  `waterReflectionScale` (0.25 medium, 0.4 high) — and it is refreshed every
  other frame (`waterReflectionFrame`; the WebGL fork also alternates). Both are
  invisible under the blur and roughly halve the extra render cost. True SSR is
  not cheaper here: it still needs a depth/normal prepass and raymarching, and
  cannot reflect geometry that is outside the main view. The plane is
  `WATER_SIZE` (140 km) but both shaders dissolve it into `skyColor` between
  `WATER_FADE_START` (18 km) and `WATER_FADE_END` (45 km) from the map centre:
  this is a flat orthographic map with no globe limb, so without the fade the
  ocean runs to the edge of the view as an infinite sheet. Keep the fade
  uniforms in sync in `webgl-water.js` and `webgpu-water.js`; the fade colour
  follows `skyColor` in `applyLighting()`. Low quality uses a flat unlit
  `MeshBasicMaterial` in `WATER_LOW_COLOR` (no fade). The plinth was removed: it
  sat under the mirror camera and blocked the reflection render.
- The mirror view needs geometry the main camera culls: a tower of height `h`
  appears in the water up to roughly `h / tan(pitch)` further toward the camera
  than its ground footprint, so at high zoom the traversal detached those tiles
  and tall buildings lost their reflection. `createTilesRenderer` wraps
  `calculateTileViewError` to force `inView` for every tile whose bounding volume
  intersects a `WATER_REFLECTION_KEEP_RADIUS` (600 m; world units are metres)
  sphere around the view target, converting the target into the tiles group's
  local space first. The base error is kept, so LOD is unchanged, and the meshes
  keep `frustumCulled`, so off-screen tiles cost nothing in the main pass while
  remaining available to the mirror pass. This is a floor, not a full solution:
  a very tall tower at a very low pitch can still fall outside 600 m.
- Bridges are painted into the basemap and intentionally do not get separate
  shadow meshes.
- Tilt shift is optional and blurs the top/bottom bands based on
  `abs(uv.y - 0.5)`. It uses an `EffectComposer` `ShaderPass` on the WebGL
  renderer and a TSL `RenderPipeline` pass on WebGPU, since the classic
  composer does not run on `WebGPURenderer`. The same pass also applies the
  screen vignette (`VIGNETTE_STRENGTH`, 0.06).
- Tilt shift is LOD-driven: `updateTiltShiftStrength()` fades it from full
  strength at `camera.zoom <= 3` to zero at `>= 10`, because detailed tile
  geometry reads as mush when blurred. The strength therefore varies between
  0 and 1, not just on/off.
- The composer/RenderPipeline runs whenever AO is on or the tilt-shift
  strength is above zero. On `low` quality (AO off) at high zoom, where the
  LOD has faded tilt shift out, the frame is rendered directly.
  `tiltShiftPass.uniforms.strength` and `tiltShiftStrengthNode` carry the
  strength value.
- The compass button resets bearing to north while preserving zoom and tilt.
- The rotate-left/right and tilt-up/down buttons step the camera by a fixed grid
  (30° bearing, 15° pitch) and tween each step over `ROTATE_DURATION` (280 ms).
  Read the block comment above `rotateByStep()` in `main.js` before touching it.
  The conventions that trip people up:
  - `pitch = 90 - polar` and `bearing = 180 - azimuth` (`getAzimuthalAngle()`
    wrapped to ±180). "Rotate right" therefore *lowers* bearing and "tilt up"
    *raises* pitch; both `stepTarget()` call sites pass the opposite sign to the
    label, on purpose.
  - The camera is posed absolutely (`setCameraAzimuth()`, `setCameraPitch()`),
    never through `controls.rotateLeft()`/`rotateUp()`. Those accumulate into
    `_sphericalDelta` and only apply on `update()`, so a per-frame tween loop
    re-applies its correction every frame and overshoots.
  - `stepTarget()` snaps onto the *nearest* grid line, which is what makes a
    press at 29° land on 30° instead of 60°. When that nearest line is outside
    the pitch bounds (pitch 1° has 0 as its nearest line) it uses the next line
    inside the bounds instead, or the press would be a no-op at a limit.
  - Rapid presses queue because each press steps from the in-flight tween
    target, not the camera's mid-animation angle.
- Pitch range is 1°–90°, set by the MapControls polar limits (polar 0 is
  straight down, polar π/2 is the horizon): `minPolarAngle = 0` and
  `maxPolarAngle = π/2 - 1°`. `MIN_PITCH_DEG`/`MAX_PITCH_DEG` derive from those
  limits, so change the limits rather than the pitch constants. Straight-down
  (90°) relies on the bearing being well-defined from the camera's existing
  orientation; do not add other code that assumes a non-zero horizontal offset
  at that angle.
- Fog is tilt-driven, not a toggle. `scene.fog` is a `THREE.Fog` in `FOG_COLOR`
  and `updateFog()` runs every frame. Because the camera is orthographic, every
  ray is parallel, so a ground fragment's view depth is `dm` at the screen
  centre and grows by `halfHeight / tan(elevation)` at the top edge — the band
  is expressed as fractions of that half range, which pins it to the screen at
  every zoom. Strength ramps in from `FOG_START_ELEVATION` (18) to
  `FOG_FULL_ELEVATION` (5) and fades back out between `FOG_ZOOM_FADE_START`
  (6) and `FOG_ZOOM_FADE_END` (14) because at high zoom there is no far edge to
  fog. Elevation is `90 - polar`, i.e. the `pitch` printed by `om3dLog()`; keep
  these low so the fog only appears near the horizon instead of on every slight
  tilt. `?fog=0` disables it.
- `FOG_COLOR` is the same as `SKY_COLOR`, and both differ from `BG_COLOR`
  (the basemap/ground grey). The fog's opaque end has to match the sky, since
  culled far tiles reveal sky or fogged ground behind them; a light blue reads
  as distance haze.
- The camera far plane follows the fog: past `fog.far` everything is fully
  painted over, so `camera.far` is pulled in there (plus `FOG_CULL_SLACK`) and
  `TilesRenderer`'s frustum culling drops those far tiles for free. The plane is
  quantised by `FOG_CULL_STEP` of the band width so a slow tilt does not
  reshuffle the tile set every frame. The band is deliberately a thin horizon
  strip (`FOG_FAR_END` 0.82, i.e. opaque only near the top edge): an earlier,
  thicker band blanked the top ~25% of a portrait view, which reads as missing
  map, so it was narrowed. The trade-off is less culling — measured at a horizon
  tilt in landscape this drops ~4% of meshes/vertices (~223 vs 232 at zoom 2),
  not the ~26% a thicker band gave. The normal `far` is `ORTHO_FAR` (200000).
- Keep `fog: false` on materials rendered for a different purpose than the main
  view (`coverageMaterial`): they use the sun's camera and must not be tinted.

## Mobile performance

`main.js` uses a `basemapMoving` flag to keep the basemap LOD stable while the
camera moves and raise the 3D tile `errorTarget`; both restore after 180 ms
idle. This avoids repeated tile-level teardown and keeps panning responsive.

Quality tiers (`QUALITY_PRESETS` in `main.js`) are the main mobile memory
control. iOS/coarse-pointer/low-memory devices auto-select `low`; a manual
choice is stored in `localStorage` and `?quality=` overrides both.

- `low`: DPR 1, 512 px basemap tiles (same road resolution as high — smaller
  canvases were reported to break up thin road strokes in Safari), 28 basemap
  tiles, 2 active basemap loads, 500 ms level cleanup, 96 MB tile cache,
  errorTarget 24/40, 1024 shadow map, `BasicShadowMap`, AO off, flat
  (non-reflective) water, coverage pass and `displayActiveTiles` off, shadows
  paused while moving. With AO and tilt shift off the frame is rendered directly
  (no composer/RenderPipeline), so the extra full-screen targets are never
  rendered.
- `medium`: DPR 1.25, 512 px basemap, 64 tiles, 5 active loads, 1200 ms
  cleanup, 192 MB cache, 14/24, 2048 shadow map, `PCFShadowMap`, AO on, water
  reflection at 0.25 scale.
- `high`: DPR 1.5, 512 px basemap, 256 tiles, 10 active loads, 2000 ms cleanup,
  512 MB cache, 8/16, 4096 shadow map, `PCFShadowMap`, AO on, water reflection
  at 0.4 scale.

The basemap texture budget is what used to exhaust Mobile Safari when tilting
(a low camera angle makes the visible footprint huge): 256 tiles at 512 px is
roughly 256 MB of `ImageBitmap`s plus 256 MB of GPU textures before other
overhead. `qualityConfig.basemapMaxTiles` controls it.
Never reintroduce a canvas per basemap tile: textures are `ImageBitmap`s closed
on dispose, scratch canvases are shared per size, and `basemapRequests` entries
are removed in `finally` so resolved promises do not retain their images.

### Memory instrumentation

`window.om3dMemory()` returns a live snapshot: renderer geometries/textures/
texture bytes/render targets/active shadow filter, tile-cache items/MB/queues/
cumulative loads and disposals, basemap live meshes/textures/bitmaps and
cumulative canvas/bitmap allocations, vector-tile cache size, and zoom/pitch.
`om3dLog()` and the settings panel's "Copy debug info" include the same block.

Use it before/after a panning session. Live counters (geometries, textures,
cache MB, live bitmaps, render targets) should level off; `canvasAllocs` and
`bitmapAllocs` are cumulative churn counters, so only their rate matters. With
the shared-canvas/`ImageBitmap` pipeline, a long session should stay at ~2–3
canvas allocations and one live bitmap per loaded basemap tile.

- `?shadows=1` starts with shadows enabled; the `#shadows` toggle is in the
  settings panel.
- `?lighting=1` starts with time-of-day lighting enabled; the `#lighting`
  toggle is in the settings panel and works with or without shadows.
- `?renderer=webgl` uses the classic `WebGLRenderer` (with `EffectComposer`).
  `?renderer=webgl2` uses the node renderer with `forceWebGL: true`, i.e. the
  WebGPU-style path on a WebGL2 backend. `?renderer=webgpu` forces the node
  renderer on WebGPU; the default is the same with a classic WebGL fallback
  when WebGPU is unavailable.
- `?debug=1` turns on the throttled view-state logging in the console
  (`[om3d] move` / `[om3d] idle`). It is off by default because each log builds
  a full tile-stat snapshot. `window.om3dLog(label)` and `window.om3dMemory()`
  still work manually. `?ao=0` and `?fog=0` disable those effects.

## Renderer parity (WebGL and WebGPU)

Every feature must work the same way on both renderer paths. When adding or
changing a feature, implement it for both and verify it visually on each path:
`?renderer=webgl` and the default WebGPU path (`?renderer=webgl2` exercises the
node renderer against a WebGL2 backend).

Renderer-specific code is intentionally limited to:

- renderer creation and the WebGL fallback. Both paths use standard
  (non-reversed) depth: the AO G-buffer and shadow comparisons expect it, and
  orthographic depth is linear so precision is not a concern;
- the clay material: GLSL `onBeforeCompile` on `MeshLambertMaterial` for WebGL,
  TSL `MeshLambertNodeMaterial` + `CoverageLightingModel` for WebGPU;
- `SHADOW_CATCHER_OPACITY`, tuned per backend (`0.56` WebGL, `0.7` WebGPU) so
  the shadow catcher looks the same;
- tilt shift and vignette: `EffectComposer`/`ShaderPass` on WebGL and a TSL
  `RenderPipeline` pass on WebGPU. Both share `TILT_SHIFT_KERNEL` and
  `VIGNETTE_STRENGTH`, so the result is identical;
- ambient occlusion: `GTAOPass` on WebGL and `GTAONode` on WebGPU, sharing
  `AO_RADIUS`, `AO_THICKNESS`, samples, and scale;
- reflective water: `webgl-water.js` on WebGL and `webgpu-water.js` plus
  `renderGPUWaterReflection()` on WebGPU, sharing `WATER_REFLECTIVITY`,
  `WATER_NORMALS`, `WATER_COLOR`, distortion, and the per-tier reflection
  scale. The low tier's flat `MeshBasicMaterial` water is shared.

If a feature genuinely cannot be implemented on one renderer, document the gap
here and ask the maintainer before shipping it.

## Tiles

Repository policy:

- `tiles/` is the current raw download and is ignored; `tiles-old/` is the
  ignored 2021 raw backup.
- `optimized-tiles-old/` is the ignored 2021 backup.
- `optimized-tiles/**/*.glb` is ignored.
- `optimized-tiles/**/*.b3dm` and `optimized-tiles/tileset.json` are checked
  in; this is the generated, simplified current dataset (~505 MiB).

Source endpoint:

- The old `https://www.onemap3d.gov.sg/files/sg_3dtiles/` endpoint is retired.
- Tiles now come from
  `https://www.onemap.gov.sg/omapi/tilesets/sg_noterrain_tiles/`.
- The tileset JSON requires a `Referer: https://www.onemap.gov.sg/3d` header.
  Tile payloads themselves are CORS-enabled.
- `ONEMAP_3D_TILESET_URL` can override the tileset URL.

Current dataset:

- 24,644 tiles, spread across path levels `3/` through `8/`.
- `--max-level=N` filters on the first numeric path segment. Level 5 keeps
  about 5,700 tiles; the full set is 24,644.
- Tiles are already Draco-compressed upstream, so there is no optimization
  step. `--strip-textures` only removes the images; it leaves the Draco
  geometry untouched.

Full-download estimate (for the README's 130–175 GB warning):

- Systematic sample: every 225th URI (`n=110`), average 5,366,946 bytes,
  extrapolated to 123.18 GiB (132.3 GB).
- Random sample (`n=60`), average 7,058,966 bytes, extrapolated to
  162.0 GiB (174.0 GB).
- Both samples used `content-length` from HEAD requests. The spread is large
  (median ~1.3 MB, p90 ~15–20 MB, max ~46 MB), so treat the estimate as an
  order of magnitude, not a precise size. Note that the "GB" values originally
  printed were GiB (powers of 1024); in decimal GB the range is ~132–174 GB.

`fetch-tiles` behavior:

- `--output=DIR` selects the destination (default `tiles`).
- `--max-level=N` filters on the first numeric path segment.
- `--concurrency=N` controls parallel requests (default 8).
- `--max-bytes=N` stops once that many bytes have been written to disk,
  including `tileset.json`.
- `--strip-textures` parses each B3DM, removes `images` / `textures` /
  `samplers` and material texture references, rebuilds the GLB with only the
  non-image bufferViews, remaps accessors and the Draco bufferView, and
  rewrites the B3DM. Materials become flat gray. It assumes a single glTF
  buffer; tiles without images are copied unchanged.
- Failed URIs are written to `<output>/failures.txt`. Retry them with
  `npm run retry-tiles -- --output=DIR`; the retry uses a slower backoff and
  rewrites the file with whatever is still failing.

Textures dominate the current dataset: in an 886-tile sample they were 97.8%
of the bytes (4,068.5 MiB of 4,158.8 MiB). Stripping the full tileset should
land around 2.1–2.3 GiB on disk.

### Simplified tileset (`optimized-tiles`)

`npm run build-toy-tiles` reads `tiles/` and writes `optimized-tiles/`. It
runs the builder in 500-tile child processes because the Draco/meshoptimizer
WASM heap grows over a full run.

- Selection keeps all content through depth 8; branches with no content by
  depth 8 are filled from their first deeper content tile so there are no
  blank areas. The npm build also applies a deeper MBS override up to depth
  15 via `--deep-area=103.8565,1.2800,103.8640,1.2870,15`.
- Missing source files are treated as empty and filled from an existing
  descendant; same-region siblings often cover the original hole.
- Each tile is decoded from Draco, split by `_BATCHID`, welded, and simplified
  per building with meshoptimizer. The settled build uses ratio 0.5, error
  0.005, and crease-preserving sharp normals; `--no-sharp` disables them.
- `--strip-metadata` is available to remove the batch table and `_BATCHID`,
  but the settled output keeps them for fidelity. Output is about 505 MiB.
- The Merlion batch is protected by default (`--protect=1.2868,103.8545,30`).
- The simplified GLB is compressed with `gltfpack -c` (meshopt) and wrapped
  back into the B3DM; with `--strip-metadata` the batch table is removed and
  `BATCH_LENGTH` is set to 0.
- `main.js` points at `optimized-tiles/tileset.json`; `?tiles=...` can load
  another tileset for comparison. `optimized-tiles-old/` and the raw `tiles/`
  source are gitignored.
- `postbuild` copies `optimized-tiles` into `dist/optimized-tiles`.

## Export page (`/export/`)

A second, standalone entry point dedicated to exporting geometry. It shares no
code with `main.js`; only `singapore-outline.js` and the dependencies are
common. Do not import from `main.js` here or vice versa — `main.js` must stay
untouched.

- Files: `export/index.html`, `style.css`, `app.js` (state machine), `map.js`
  (MapLibre + polygon editor), `tiles.js` (select/decode/clip), `geometry.js`
  (pure maths), `formats.js` (STL/GLB/glTF), `preview.js` (three.js preview).
- `vite.config.js` declares both inputs (`index.html`, `export/index.html`).
  Without that, `/export/` works in `npm run dev` but is never emitted by
  `npm run build`, so it 404s on the deployed demo.
- The map is MapLibre GL JS against OpenFreeMap's `positron` style. That is
  deliberate: the main page's basemap has no building footprints or labels, and
  choosing an export area is impossible without them, so we get them from the
  style rather than re-implementing text shaping and label collision.
  `setWorkerUrl(workerUrl)` with Vite's `?worker&url` import is **required** —
  a wrong worker URL only fails under `vite build`, never in dev.
- The tileset URL is resolved against `document.baseURI`, **not**
  `import.meta.url`. Using the module URL makes Vite copy `tileset.json` into
  `dist/assets/` and every relative `content.uri` then points at a directory
  with no `.b3dm` files.
- **Tile selection must be leaf-most.** The tileset is `refine: "REPLACE"` and
  content nodes have children that also carry content (`4/0/0_5` → `_4` → `_3`),
  so collecting every `content.uri` emits each building 3–5×. `selectTiles()`
  recurses first and only emits a node's own content when no descendant matched.
- The ECEF→world frame is rebuilt from `WGS84_ELLIPSOID.getObjectFrame(...)`
  and inverted, mirroring `ReorientationPlugin`. Per tile the world matrix is
  `ecefToWorld × mesh.matrixWorld`; `mesh.matrixWorld` already includes the tile
  scene's `RTC_CENTER` and Z-up rotation, so never multiply by
  `tileScene.matrix` again. `optimized-tiles` are meshopt-compressed and
  quantized: read with `position.getX/getY/getZ` or the dequantization is lost.
- Polygons are stored as `{lat, lon}` and converted with the ellipsoid, not with
  `main.js`'s Mercator `lonLatToWorld`, which drifts by metres at the island's
  edge.
- Clipping triangulates the ring with `ShapeUtils.triangulateShape` and clips
  against the convex pieces, so **concave** polygons are exact. A triangle fully
  inside the ring short-circuits and is kept whole, otherwise the triangulation's
  interior diagonals would needlessly split it.
- Units: world is metres. Output is millimetres in "fit to print size" mode
  (scale derived from the XZ footprint, buildings ∪ drawn area) or raw metres in
  the GLB/glTF "real 1:1" mode. Two distinct factors coexist and must not be
  confused: `mmPerMetre` (print scale) and `unitPerMetre` (output units). Plate
  thickness is authored in millimetres and converts with `mmPerMetre`, so using
  `unitPerMetre` would make a 2 mm plate 2 m thick in 1:1 mode.
- The base plate is optional, with a thickness (0.6–8 mm) and a margin (0–10 mm),
  both applied in print millimetres. In GLB/glTF it is a separate `BasePlate`
  node so it can be deleted in one click.
- **`computeGroundY` samples one base per building, not one per triangle.** A
  tall building is many wall triangles whose min-Y spreads up its whole height,
  so a per-triangle histogram is dominated by whichever storeys carry the most
  subdivisions; the mode then lands tens of metres up the side of a tower and
  the plate visibly slices through it (measured 27 m wrong at Jurong East).
  `buildingBasesFromBuckets` reduces each bucket to `min(triangleMins)` first.
- The plate top stays at the **modal** building base rather than the maximum.
  No rule can both bury every base and float none: Singapore buildings sit on
  ground that varies by a few metres, and a handful of shells (e.g. ASIA SQUARE
  TOWER 1, base 25 m) start well above the street. Using the maximum as the plate
  top swallowed 86 of 99 buildings on a 2 km Marina crop. Mode buries the common
  case and leaves a few stragglers floating, which is the visible, fixable
  failure rather than the destructive one.
- There is no terrain in `sg_noterrain_tiles`; a building on higher ground can
  only be anchored by the slab, which is what the thickness control is for.
- **The source shells are open, and `optimized-tiles` doubles every face.** The
  upstream OneMap B3DM has no duplicate triangles but thousands of boundary
  edges (a 8.7k-triangle tile has ~25k boundary edges), so the buildings are open
  shells, not closed solids. Our built tiles then contain each triangle twice,
  emitted as consecutive identical pairs, which hides some of those gaps. Do not
  "fix" the duplication on its own: de-duplicating reveals the open shells
  immediately. Filling them needs a real hole-filling pass, which is not done.
- The preview draws the drawn polygon as a dashed `Line2` plus numbered sprite
  badges, on the plate's top surface. Sprites are used because they always face
  the camera; their canvas textures must be disposed with the material. The
  whole annotation set toggles via `setAnnotationsVisible()`; keep those objects
  in `annotationObjects` rather than only in `outlineObjects`.
- `show()` must not re-aim the camera on every build. `frame()` runs only on the
  first build or when the caller passes `{ refit: true }`, otherwise a live
  rebuild yanks the view out from under someone orbiting. Only the clip planes
  are refreshed.
- Buildings are separated by the tile's `_BATCHID` attribute, which the loader
  lowercases to `_batchid`. `extractWorldTriangles` groups triangles per batch and
  the clip pass accumulates into one bucket per building (`<tileUri>#<batchId>`),
  which is what powers the Buildings list. Unticking a row excludes that bucket
  from both the preview and the export; at least one row is always kept ticked.
- `gml:name` in the batch table is populated for only ~4% of buildings, so rows
  are labelled `Building N` with height/usage as the detail unless a name exists.
- Plate thickness and margin are hidden when the base plate is off.
- Model size, plate on/off, thickness, margin, format, scale mode, colour scheme,
  wireframe, outline visibility and the unticked building keys are persisted in
  `localStorage` under `om3d.export.settings`. `syncPlate`/`syncSizeButtons` push
  state back into the slider inputs, not just their labels, or a restored value
  would not show on load. The area polygon has its own key, `om3d.export.area`.
- The preview defaults to the `iridescent` scheme; its plate grey must stay well
  above the near-black background or the slab reads as a hole and the buildings
  look like they float.
- Positron draws the `building` fill at layer 8 and every road class after it, so
  paths painted over the footprints. `liftBuildingsAboveRoads` calls `moveLayer`
  to lift it above the last line layer; boundary lines and our own polygon stay
  above, which is correct.
- A map click only inserts a vertex within `INSERT_RADIUS_PX` (28) of an existing
  edge, measured in screen pixels at the current zoom. A click anywhere else is
  ignored, so an accidental tap while panning cannot spawn a stray vertex.
- The page starts with **no** outline. The first click creates one: a bounding box
  of the clicked building footprint when the click lands on a building in the
  MapLibre style, otherwise a fixed 600 m square centred on the click.
  `queryRenderedFeatures` must be given `[x, y]` (or a real `Point`) — a plain
  `{x, y}` object silently returns every rendered feature instead of filtering.
- A click snaps to **one polygon part**, not the union of everything returned. OSM
  building features are often MultiPolygons whose parts are separate structures
  spread across the map (Marina Bay Sands reports 5 disconnected parts, one
  hundreds of metres away), so taking the bbox of every ring of every hit unions
  in far-off geometry and the same building yields different rectangles depending
  on where you click. `polygonParts` splits the geometry, then the **largest** part
  containing the click wins: a landmark is a pile of overlapping polygons (tower,
  SkyPark, small decoration shapes), so picking the smallest would snap a click on
  a decoration to that sliver instead of the building.
- The snapped box is capped at `MAX_CLICK_BOX_M` (450 m) **including its padding**,
  so one click can never frame half a district. The cap is applied to the final
  size, not the footprint, or the 8% margin pushes it past the limit.
- Clearing must also empty the preview *and* the Buildings list. Fewer than 3
  vertices makes `buildPreview` return early, so `onPolygonChange` calls
  `clearPreviewPane()` directly rather than relying on a build to do it.
- `preview.js` renders on demand, so `disposeMeshes()` must set `needsRender`;
  otherwise the canvas keeps showing the last frame after a clear.
- Below 900 px the preview is a full-screen overlay, and **Build preview opens it**
  (`buildPreview` calls `openPreview()` for manual builds only). Do not add a
  separate "View 3D" trigger: building into an invisible pane and then pressing a
  second button is one step too many. Live rebuilds never open the overlay, since
  that would pop up while handles are being dragged. Crossing the breakpoint drops
  the `preview-open` class, or a leftover overlay state would pin the pane
  full-screen on a wide layout.
- Zoom comes from three places and they must agree: OrbitControls' own wheel and
  pinch, the `+`/`−` buttons, and a `wheel` listener on the canvas. Both call
  `zoomBy(factor)`, which scales the camera-to-target distance so behaviour is
  identical.
- The layout is a CSS grid: map left, live 3D preview right above 900 px. Below
  that the preview is a full-screen overlay toggled from the panel.
- A rebuild is triggered by a 350 ms debounce on any outline or model option
  change. Decoded tile geometry is cached per URI in `tileCache`, so a rebuild
  after the first is ~100 ms and issues no network requests. `clipWorldTriangles`
  is the cheap per-polygon half; `extractWorldTriangles` is the expensive one.
- A `buildToken` guards against overlapping builds: an older run bails out rather
  than painting over a newer preview.

## Deployment

- The live demo is on Netlify (`om3d.netlify.app`); Netlify builds from the
  tracked `optimized-tiles/`.
- `public/_headers` sets a 30-day cache for `/optimized-tiles/*` on Netlify.
- `.github/workflows/main.yml` also builds and deploys `dist/` to the
  `gh-pages` branch with `actions/checkout@v7`, `actions/setup-node@v7`
  (Node 24), and `JamesIves/github-pages-deploy-action@v4.9.0`. The published
  Pages site is ~505 MiB, within its 1 GiB limit; the `gh-pages` branch also
  carries the tiles, so a clone of both branches is over 1 GiB.
- CI installs with `npm ci` and builds with Node 24.

## Gotchas

- `base: ''` in `vite.config.js` keeps asset URLs relative, which the current
  hosting setups need.
- The basemap needs no API key: OpenFreeMap serves the vector tiles directly.
  A handful of upstream tiles return `403 Forbidden` permanently. They stay in
  `failures.txt`; the demo will show small holes if they are not pruned from
  the tileset.
