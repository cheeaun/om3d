Singapore buildings 3D Tiles from OneMap 3D on Mapbox GL JS
===

This is a demo of Singapore buildings 3D tiles from [OneMap 3D](https://www.onemap3d.gov.sg/) on Mapbox GL JS.

Development
---

``` bash
# install dependencies
npm i

# Start local server
npm start

# Download tiles from OneMap to ./tiles/*
# Roughly 700-800 MB
npm run fetch-tiles

# Generate optimized tiles into ./optimized-tiles/*
# Roughly 50-60 MB
npm run optimize-tiles
```

This uses [Deck.gl](https://deck.gl/)'s [Tile3DLayer](https://deck.gl/docs/api-reference/geo-layers/tile-3d-layer) to render [3D Tiles](https://www.opengeospatial.org/standards/3DTiles).

The files in `./tiles` and `./optimized-tiles/*.glb` are excluded from this repository because they takes up too much space and unnecessary for this demo.

Copyright
---

@ [SLA](https://www.sla.gov.sg/) @ [OneMap](https://www.onemap.gov.sg/legal/termsofuse.html)