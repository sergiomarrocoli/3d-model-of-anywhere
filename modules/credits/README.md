# Credits module

The credit line along the bottom of the game, plus a **Credits** button that opens an overlay listing every source the
area used: what it is for (terrain, buildings, imagery), its name and link, its licence and link, the exact credit text,
and a note where there is something to be careful about (the Esri imagery is development use only).

```js
import { mountCredits } from '@credits';
const credits = mountCredits(document.getElementById('credits'), map.attribution);   // credit lines from the bundle
credits.open(); credits.close(); credits.destroy();
```

It knows nothing about the game or the map: give it the credit lines (`meta.attribution`, which the pipeline writes into
every bundle). It closes with the x, the backdrop or Escape.

- `sources.js` the table of known sources (Environment Agency, Welsh Government, Natural Resources Wales, Ordnance
  Survey, OpenStreetMap, Esri, Copernicus Sentinel-2) and `describeCredits(lines)`. A line it does not recognise is still
  shown, word for word, under "Other", so a new source is never hidden. Add an entry when the pipeline gets a new source.
- `index.js` the footer, the overlay, and `creditsHtml`, which escapes everything it shows.

Tests: `test/credits.test.js` (run with `npm test` in `client/`).
