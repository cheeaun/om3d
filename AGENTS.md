# AGENTS.md

Context for coding agents working on this repository.

## Stack

- Vite 8 (requires Node.js 20.19+; CI uses Node 24)
- deck.gl 9.4 (`Tile3DLayer`, `ScenegraphLayer`, PBR lighting)
- loaders.gl 4.5 (`Tiles3DLoader`, `DracoLoader`)
- mapbox-gl 3.34, bundled from npm by Vite — there is no CDN script or
  stylesheet anymore
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

`postbuild` runs `scripts/copy-tiles.mjs`, which copies only `tileset.json` and
`*.b3dm` into `dist/optimized-tiles`. Do not copy the whole directory: the old
pipeline left ~808 MB of intermediate GLBs behind.

## Key files

- `main.js` — map setup, deck.gl overlay, `Tile3DLayer`, start gate
- `index.html` — markup and warning overlay (no external Mapbox assets)
- `style.css` — app styles only; Mapbox CSS comes from the npm package
- `vite.config.js` — base path and fixed dev/preview ports
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

- `@deck.gl/mapbox` v9 removed `MapboxLayer`. Use `MapboxOverlay` with
  `interleaved: true`, and set `beforeId` on the deck layer to place buildings
  under the map labels.
- `layerFilter` hides the 3D layer below zoom 13 without tearing down the
  tileset state.
- Keep `maximumMemoryUsage` at a sane value (currently 64 MB) and
  `maximumScreenSpaceError` around 8. The previous `1` / `1` values caused
  constant tile eviction and excessive requests.
- The Mapbox basemap fills its depth buffer with near-plane values. Interleaved
  `ScenegraphLayer` draws are hidden unless `depthTest` / `depthWrite` are
  disabled on the `scenegraph` sublayer.
- deck.gl v9 PBR lighting is much brighter than v8. The light intensities were
  reduced (ambient 1.2, directional 2 + 0.6) so the flat-gray buildings do not
  wash out against the light basemap.
- loaders.gl fetches the Draco decoder from `gstatic.com` automatically. The
  upstream OneMap tiles are already Draco-compressed, so this path is required
  for rendering.
- The deck group is inserted at `deck-layer-group-before:<first label layer>`.
  If labels start rendering above buildings incorrectly, check how
  `labelLayerId` is resolved in `main.js`.

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
- The Mapbox access token in `main.js` is the public demo token; do not replace
  it with a secret token without a plan for exposing it client-side.
- A handful of upstream tiles return `403 Forbidden` permanently (they also
  fail with a browser user agent). They stay in `failures.txt`; the demo will
  show small holes if they are not pruned from the tileset.
