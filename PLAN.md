# Prototype plan: walkable UK map game

Pick any small area of the UK on a map, and the game builds it as a walkable 3D scene from real data: terrain from a DEM, buildings from footprint polygons, and aerial imagery draped over everything. The camera is a high, angled, near-top-down view in the style of Cannon Fodder or Sensible Soccer.

## Goal of the prototype

The prototype proves the pipeline end to end on one area:

1. Select a roughly 500 m × 500 m box on a slippy map.
2. Fetch and process the terrain, buildings and imagery for that box.
3. Load the result into a 3D scene where a character can walk around, follow the ground height and collide with buildings.

Gameplay, art polish and large areas are out of scope.

---

## 1. Data sources

All processing happens in **British National Grid (EPSG:27700)**. Its units are metres, it's flat and it's what UK data ships in, so there's no projection maths inside the game.

### Terrain (DEM)

| Source | Resolution | Coverage | Licence | Notes |
|---|---|---|---|---|
| **Natural Resources Wales LiDAR** (DataMapWales) | 1–2 m DTM + DSM | Wales, patchy | OGL | First choice for Welsh test areas |
| **Environment Agency LiDAR Composite** | 1 m DTM + DSM | England, near-complete | OGL | Bulk tile download |
| **Scottish Remote Sensing Portal** | 0.5–2 m | Scotland, patchy | OGL | |
| **OS Terrain 50** | 50 m | GB | OGL | Fallback everywhere; too coarse for detail |
| **Copernicus GLO-30** | 30 m | Global | Free | Alternative fallback |

- **DTM** (bare earth) is the ground mesh.
- **DSM − DTM** gives a normalised height model, which yields real building heights per footprint (see §3).

### Buildings

| Source | Licence | Notes |
|---|---|---|
| **OpenStreetMap** (Overpass API) | ODbL (attribution and share-alike on the data) | Best detail; also gives roads, walls, water and trees. `building:levels` is sparse |
| **OS Open Map Local** (building layer) | OGL | Consistent GB-wide footprints, simplified |
| **Microsoft Global Building Footprints** | ODbL | Gap-filler for rural areas OSM misses |

Start with OSM and fall back to OS Open Map Local when OSM is empty.

### Imagery

This is the hardest source to get. At this camera height you need roughly **25–50 cm per pixel**; Sentinel-2 at 10 m is useless.

| Source | Resolution | Licence status |
|---|---|---|
| **Welsh Government aerial imagery** (DataMapWales) | ~25 cm | Check the current licence; parts may be OGL |
| **Esri World Imagery** tiles | ~30 cm in the UK | Fine for personal dev and testing; **not** licensed for a distributed game |
| **Mapbox Satellite** | ~30–50 cm | Paid; check the terms for caching and game use |
| **APGB** (Aerial Photography Great Britain) | 12.5–25 cm | Public-sector only |
| **Sentinel-2** | 10 m | Free; only usable for a zoomed-out overview |

**Decision for the prototype:** use Esri World Imagery for local development only, and keep imagery fetching behind an interface so the source can be swapped later. The licence question is the main blocker if this ever becomes a released game.

---

## 2. Architecture

```
┌─────────────────┐    bbox     ┌──────────────────────┐   tile bundle   ┌────────────────┐
│ Area picker      │ ─────────▶ │ Processing pipeline   │ ─────────────▶ │ Game client     │
│ (MapLibre map)   │            │ (Python)              │                │ (three.js)      │
└─────────────────┘            └──────────────────────┘                └────────────────┘
```

### Stack

- **Area picker:** a web page with MapLibre GL and a draggable fixed-size box, which posts the bbox to the pipeline.
- **Pipeline:** Python with `rasterio`, `geopandas`, `shapely`, `pyproj` and `requests`/`osmnx`, run as a CLI first and wrapped in a tiny HTTP service later.
- **Game client:** three.js in the browser, which fits naturally with the web-based picker. Godot 4 is the alternative if this outgrows the browser.

### Tile bundle format (pipeline output)

```
area_<id>/
  meta.json          # bbox in EPSG:27700, origin, resolution, attribution strings
  heightmap.png      # 16-bit greyscale DTM, or .bin float32
  imagery.jpg        # orthophoto clipped to bbox, e.g. 2048×2048 for 500 m ≈ 25 cm/px
  buildings.geojson  # local metre coords, origin at bbox SW corner; props: base_z, height
  features.geojson   # optional: roads, walls, trees, water from OSM
```

Local coordinates are metres from the box's south-west corner, which keeps floats small and makes the game maths trivial.

---

## 3. Processing pipeline steps

1. **Fetch the DTM** tiles that intersect the bbox. Mosaic them, clip to the box, fill nodata from OS Terrain 50 and resample to 1 m.
2. **Fetch the DSM** for the same box (optional, but used for building heights).
3. **Fetch buildings** from Overpass, reproject them to 27700 and clip to the box.
4. **Clean the polygons:** fix invalid geometry, drop slivers under ~5 m², and simplify slightly. Orthogonalise later if needed.
5. **Assign each building's height**, in this order of preference:
   1. the 90th percentile of (DSM − DTM) inside the footprint;
   2. `height` or `building:levels × 3 m` from OSM;
   3. a default of 6 m.
6. **Set each building's base** to the minimum DTM height under the footprint, so buildings sit into slopes instead of floating.
7. **Fetch imagery** tiles for the box at a suitable zoom (z19 is about 30 cm), stitch them, reproject to 27700 and clip to exactly the same extent as the heightmap.
8. **Write the bundle** and attribution text (OGL, ODbL and the imagery source).

---

## 4. Game client

### Scene construction

- **Terrain:** a plane mesh with 1 vertex per metre (500 × 500), displaced by the heightmap.
- **Imagery drape:** planar UVs from local XY, mapping `u = x / width` and `v = y / height`. The same mapping is used for the terrain **and the building roofs**, so roofs pick up the real roof pixels automatically.
- **Buildings:** each footprint is extruded from `base_z` to `base_z + height`.
  - Roofs are flat caps using the planar-UV imagery.
  - Walls use a generic tiling texture (brick, render or slate), chosen by OSM `building=*` type or at random. The overhead imagery has no usable wall detail.
- **Lighting:** a single directional light with no dynamic shadows at first. The imagery already has shadows baked in, and real-time shadows would double them.

### Camera

The camera is an orthographic projection tilted about 55–65° from horizontal and locked to the player. It shows roughly 40–60 m across the screen, so the world feels big and the character feels small.

Rotation stays fixed, which keeps it readable and true to the reference games. A 90° rotate key is a later option.

### Player

- The character is a capsule or a billboard sprite with 8-direction animation (the Cannon Fodder look).
- Movement is click-to-move, Cannon Fodder style: click the ground and the player walks to that point, with velocity smoothing (accelerate, brake to arrive at rest, turn to face travel). The click is resolved by marching the camera ray against the heightmap.
- **Ground following:** sample the heightmap with bilinear interpolation at the player's XY each frame.
- **Collision:** 2D only, as circle-versus-polygon against the building footprints using a spatial grid or R-tree. No physics engine is needed for the prototype.
- Slopes over a threshold, worked out from the heightmap gradient, block movement. This stops the player walking up cliffs.

---

## 5. Known problems to expect

- **Building lean in the imagery (relief displacement).** Aerial photos aren't true orthophotos, so tall roofs appear offset from their footprints and wall pixels smear onto the ground. Accept this for the prototype. Mitigations include a small per-area offset nudge or darkening the ground near walls.
- **Baked trees and cars.** Trees are flat on the ground. A later option is to place 3D tree sprites where DSM − DTM is high but no building exists.
- **Edge of the world.** The box needs a boundary: an invisible wall, fog or a fade to black.
- **Coverage gaps.** Where LiDAR is missing, OS Terrain 50 is too smooth for small-scale slopes. This is fine for a fallback.
- **Mixed-licence attribution.** Show a credits overlay listing every source the area used.
- **Imagery licensing** blocks distribution, as noted in §1.

---

## 6. Milestones

| # | Milestone | Done when |
|---|---|---|
| **M0** | Data spike | A notebook outputs the DTM, building GeoJSON and imagery for one hardcoded 500 m box in Wales, and they visibly line up when overlaid in QGIS |
| **M1** | Pipeline CLI | `build_area.py --bbox …` writes a complete tile bundle; it works on one Welsh and one English test box |
| **M2** | Static scene | three.js loads the bundle, showing terrain with draped imagery and extruded buildings, with a free-fly debug camera |
| **M3** | Walkable | The player walks around with the fixed angled ortho camera, following the ground and colliding with buildings |
| **M4** | Area picker | A user drags a box on MapLibre, clicks "Build" and gets dropped into the generated scene |
| **M5** | Polish pass | Wall textures by building type, tree sprites from DSM, an edge fade and a credits overlay |

The first real risk is **M0 alignment**, which means getting all three sources onto the same grid with no visible offset. Prove that before writing any game code.

---

## 7. Open questions

- What's the target area size? 500 m is easy. Going beyond about 2 km means chunked streaming of the terrain and imagery.
- Should data be pre-built per area, or built on demand? On demand needs a server, plus caching to respect API limits (Overpass in particular).
- Character style: sprites (retro, cheap) or low-poly 3D (easier to animate from any angle)?
- Which game-y layer comes after the prototype: exploration, objectives, or vehicles (the Micro Machines idea)?
