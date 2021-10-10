import fetch from 'node-fetch';
import fs from 'fs-extra';

const TILESET_ROOT = 'https://www.onemap3d.gov.sg/files/sg_3dtiles/';
const TILESET_URL = TILESET_ROOT + 'tileset.json';

await fetch(TILESET_URL)
  .then((response) => response.text())
  .then(async (tileset) => {
    fs.outputFileSync('tiles/tileset.json', tileset);

    const matches = tileset.match(/url"\s*:\s*"[^"]+"/gi);
    const urls = matches.map((m) => m.match(/url"\s*:\s*"([^"]+)"/i)[1]);

    console.log(`Fetching ${urls.length} tiles...`);
    console.log(
      `This will take approximately ${Math.ceil(urls.length / 60)} minutes.`,
    );

    // for loop urls
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const fullURL = TILESET_ROOT + url;
      console.log(`↗️ ${fullURL}`);

      fetch(TILESET_ROOT + url)
        .then((response) => response.buffer())
        .then((buffer) => {
          fs.outputFileSync('tiles/' + url, buffer);
        });

      // wait 1s
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });
