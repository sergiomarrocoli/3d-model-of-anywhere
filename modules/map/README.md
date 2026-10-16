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

## Inside

`bundle.js` loader · `terrain.js` heightmap mesh · `buildings.js` extruded footprints, roofs from the DSM, wall texture ·
`collision.js` circle-vs-polygon with a spatial grid · `slope.js` · `edge.js` · `raycast.js` · `heightmap.js` sampling ·
`flycam.js` and `debug.js` (the `?fly` camera and the `?debug` inspector, for looking at a map without a game).

Tests are in `client/test/` and run with `npm test` in `client/`.
