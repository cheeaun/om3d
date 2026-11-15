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

## Rendering notes

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
  The clay is a neutral off-white Lambert (`0xfafafa`); the basemap is
  deliberately a slightly darker neutral grey so the massing reads against it.
  Keep the model brighter than the base; if the model looks "cloudy", check
  exposure and the base values before adding contrast.
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
  pass and `displayActiveTiles`; medium/high keep both. Tile loading, tile
  visibility changes, and dispose events set `shadowDirty`, so during streaming
  medium/high can re-render the 10 km shadow map and coverage pass every frame —
  throttle or coalesce those updates before touching quality.
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
  cannot reflect geometry that is outside the main view. Low quality uses a flat
  unlit `MeshBasicMaterial` in `WATER_LOW_COLOR`. The plinth was removed: it sat
  under the mirror camera and blocked the reflection render.
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
