# Picker module

Choose an area on an open map. MapLibre shows OpenStreetMap tiles; on it sits a box you drag to move and resize with eight
handles, from 0.2 to 2 km a side (default 1 km). The box is kept in British National Grid metres, so it is exactly the
rectangle the map builder will build.

```
modules/picker/client/
  index.js     createPicker({ container, centre, box, onChange })   the map and the box
               mountPickerPage(root, { onBuild })                  a full page: search, size, grid reference, GB check, build command
  box.js       the box maths: makeBox, moveBox, resizeBox (clamped), handlePosition, buildCommand   (pure)
  bng.js       WGS84 <-> OS grid with proj4 (about 5 m: it only decides where the box is drawn) and the GB extent check
  geocode.js   postcode (postcodes.io) or place name (OpenStreetMap Nominatim) -> lon/lat
  picker.css
```

The box moves three ways: drag its body, **click anywhere on the map** to put it there (size kept; clicks on the box or a
handle do not count), or press **Move the box to the middle of the map** after panning away.

Open it in the game with `?pick` (a "pick area" link sits in the top bar). It shows the box size and centre, warns if
the box leaves the Ordnance Survey grid (the data sources only cover Great Britain), remembers the last box, and shows the
`python3 -m pipeline.build_area --bbox ...` command that builds it. The **Build this area** button calls `onBuild(box)`; it
stays disabled until a host passes one (the flow does, as `pick` followed by `build`).

`pickStep` is the same page as a flow step (see `../README.md`): it resolves when Build is pressed and adds `ctx.bbox` and `ctx.box`.

```js
import { mountPickerPage } from '@picker';
mountPickerPage(document.getElementById('pick'), { onBuild: (box) => /* { minE, minN, maxE, maxN } in grid metres */ });
```

## Notes

- The box is axis-aligned in the OS grid, which is slightly turned against the map (up to about a degree in Wales),
  so it can look a touch rotated.
- OSM tiles and Nominatim are free for light use; a heavily used deployment needs its own tile source and geocoder.
- MapLibre needs its worker served by the bundler; `index.js` points it at the bundled worker file.
- Tests (`test/`) cover the box maths, the grid conversion against pyproj values, and geocoding with a fake fetch. The
  map and dragging itself are checked in a browser.
