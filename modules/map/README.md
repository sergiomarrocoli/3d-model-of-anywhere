# Map module

Takes a built area (a "bundle": heightmap, imagery, building footprints, optional LiDAR surface map) and turns it into
something a game can drop into a scene and ask questions about. The bundle format is documented in `pipeline/bundle.py`;
the builder that makes bundles is the Python `pipeline/` (`build_area.py`), the other half of this module.

```js
import { loadMap, listMaps } from '@map';
const map = await loadMap('/bundles/area_newtown', { renderer });   // or createMap(bundle) if you already have one
scene.add(map.object);                                              // terrain, buildings (pitched roofs, wall texture), lights
```

## What a map gives you

| | |
|---|---|
| `object` | `THREE.Group` to add to a scene |
| `meta`, `attribution`, `size` | bundle metadata, credit lines to show, `[width, depth]` in metres (map spans X 0..W, Z -D..0) |
| `groundY(x, z)` | ground height, bilinear |
| `raycastGround(origin, dir, opts)` | where a ray meets the ground (fast heightfield march, no mesh raycast) |
| `isSolid(x, z)` | inside a building? |
| `pushOutOfBuildings(x, z, r)` | nearest position at least `r` from every building (slides along walls) |
| `limitSlope(x0, z0, x1, z1)` | the allowed part of a move: only near-vertical ground blocks |
| `slopeSpeedFactor(x0, z0, dx, dz)` | 1 on the level or downhill, down to 0.15 uphill |
| `clamp(x, z)` | keep a point inside the map |

Coordinates are world coordinates: X east, Y up (from the lowest ground in the area), Z = -north.

## Roofs

The LiDAR surface (DSM) is noisy: tree overhang, chimneys, dormers and a 1-2 m cell, so draping it on a building makes smoothed lumps. Instead
`roof.js` fits each building the simple roof that best matches its DSM: **flat** (at the median height), **shed** (one slope), **gable** (a straight
ridge along the longer side) or **hip** (slopes on all sides, the height rising with distance from the walls). The eave height, the pitch and the
ridge height come from a regression on the roof's shape that ignores outliers; the pitch is capped at about 50 degrees; a pitched roof has to beat flat
clearly or the roof is flat. Walls go up vertically to the eaves, and a gable end is walled up to the ridge in a triangle. A gable's roof and walls are
split exactly where they cross the ridge, so its faces are exactly flat and there are few triangles; a hip bends along diagonals and is built on a 1 m grid.
A building with almost no DSM data under it (a tiny shed), or one no simple roof matches (a tall block with a low annex, an odd roof: the best
fit is still 3 m (2 m for a flat one) away from the DSM on average, `MAX_ERROR_M`), falls back to the raw DSM roof.
The raw DSM roof copes with outlines that are bigger than the roof (a 1-3 m rim of car park or lawn inside the outline): the roof height at each edge is
read further in, as a high percentile of the DSM 1-4 m inside it, pooled along 6 m of the edge so neighbouring wall pieces agree, and nothing within 4.5 m of
an edge dips below it. So the wall goes straight up to the eaves instead of the roof sloping down to the ground like a tent.

### Zones (buildings of several levels or wings)

A building no single roof fits (a tall block with a low annex, a main roof with a flat wing, a church with a lower aisle) is cut into **zones**
(`fitBuildingRoof` in `roof.js`), the way a regression tree splits data: try the straight cut, across either of the building's own axes, that best
separates the DSM into two levels; keep it if the two halves fit clearly better than the whole (`SPLIT_GAIN`); carry on into each half while it still
fits badly (`SPLIT_ERROR_M`; zones are at least 3 m wide, up to 8 zones). Each cut is then placed to 0.1 m on the steepest part of the step in the DSM.
Each zone gets its own flat, shed or gable roof, and:

- the roof triangles are split exactly on every cut, each triangle takes the zone it is in, and a **vertical step face** fills the gap between two
  roofs along the cut (a vertex on a cut is duplicated, one copy per zone);
- a zone that is just **bare ground** (a flat zone within 1.5 m of the building's base: a 3 m or wider strip of car park or lawn the outline takes in) gets
  no roof and no outline wall, and the step beside it is a wall straight down to the base. That clips the footprint to the real building, only where
  the LiDAR clearly shows no roof (a building the LiDAR sees nothing of at all is not clipped away);
- if any zone still fits no simple roof the whole building keeps the raw DSM roof (about 7 percent of Newtown, 17 percent of Bath, mostly very
  complex buildings such as the Abbey).

### Facades (walls)

Walls are no longer mottled grey: `facade.js` decides each building's look from its OSM tags and size (`facadeLook`), and the wall shader draws it
(`FACADE_GLSL` in `buildings.js`), addressed in metres along and up each wall so it carries on across the pieces a wall is split into:

- **Material:** brick, stone, render or cladding, from `building:material`; when untagged, red-ish photo colour means brick, pale means render, and
  the rest is a seeded mix of brick, render and stone. Render comes in a pastel palette (cream, white, pale yellow, pink, blue-grey). `building:colour`
  tints the wall when tagged. Brick and stone are courses and blocks that fade out when too fine for the pixels.
- **Windows, doors and shopfronts** are currently switched off (`FACADE_WINDOWS` in `buildings.js`): they looked too regular, so walls are plain brick, stone
  or render. The rest of this section describes what the switch turns on.
- **Windows:** a grid per storey, with sills and frames (sash bars on house windows), centred in bays with a blank margin at the corners. House windows for
  houses and plain buildings, big windows for flats, offices and anything over 15 m, tall narrow ones for churches, none for sheds, garages, barns,
  warehouses and anything under 3.2 m. Floors are `building:levels` apart (the height divided by the levels), else 2.8 m (3.4 m for large, 6 m for tall).
  Windows only appear where a whole storey fits under the wall top at that point, so gable ends step up with the roof.
- **Ground floor:** some bays are doors (in a colour picked per building); a building with a `shop` or a shopfront `amenity` (pub, cafe, bank...) gets wide
  shop glazing with a fascia sign. Plus a damp plinth along the bottom and a coping line along the top.
- Each building's look is stable (a seed from its OSM id), so neighbours differ and it never changes between loads.

The tags come from the pipeline: `building:levels`, `building:material`, `building:colour`, `shop` and `amenity` are fetched and written into the bundle.
`python3 -m pipeline.retag data/bundles/area_x` adds them to a bundle built before that, from the cached Overpass answer (no network; bundles whose
cached answer has gone are left alone). Most buildings have no such tags, so most of the look is the guess from type and height.

## Inside

`facade.js` the look of a building's walls from its tags · `bundle.js` loader · `terrain.js` heightmap mesh · `buildings.js` extruded footprints, roofs, wall texture · `roof.js` fits a clean roof to the DSM ·
`collision.js` circle-vs-polygon with a spatial grid · `slope.js` · `edge.js` · `raycast.js` · `heightmap.js` sampling ·
`flycam.js` and `debug.js` (the `?fly` camera and the `?debug` inspector, for looking at a map without a game).

Tests are in `client/test/` and run with `npm test` in `client/`.
