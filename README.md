# uk-map-3d

> **Keep this repository private.** Do not make it public until the imagery rights issue has been settled: the pipeline
> currently draws on Esri World Imagery, which is for development use only, and screenshots, GIFs, a live demo or
> committed imagery built on it may not be allowed. See "Before going public" below.

Pick a box anywhere in the UK and walk around it in 3D. A Python pipeline turns open map data (terrain heights, building
outlines and heights, aerial imagery) into a small tile bundle, and a three.js client builds the scene from it.

This repository is only about selecting an area and building a map. The games that use it (a Micro Machines style racer,
a Cannon Fodder style walker, multiplayer) live in `civil-war`, which installs this as a package.

## What is here

- `pipeline/` and `build_area.py`: terrain, buildings, imagery and the tile bundle format (Python; tests in `tests/`).
- `modules/`: `picker` (choose a box on a map), `builder` (an HTTP service that builds it), `map` (reads a bundle, draws it,
  answers ground-height, collision and destruction questions), `credits` (the source and licence lines) and `flow` (the step
  runner). See [modules/README.md](modules/README.md).
- `src/main.js`: the viewer, which picks, builds and flies round an area. `?landcover` (or the L key) tints the ground by land cover.
- Cars are painted out of the imagery, optionally, by [aerial-car-detector](https://github.com/sergiomarrocoli/aerial-car-detector) (a fine-tuned YOLO11n, 5.7 MB): `pipeline/cars.py`. See "Remove cars" below.

## Run it

```
npm install
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
python3 build_area.py --help            # build an area into data/bundles/
npm run dev                             # http://localhost:5173/?area=<id>; ?pick chooses and builds one
python3 modules/builder/server/serve.py # the build service the picker uses
npm test && python3 -m pytest           # JavaScript and Python tests
```

## Land cover

Every build also writes `landcover.png`: one class id per half metre (road, paved, grass, bare, tree, water, building), so a
game can ask what is under a wheel (`map.surfaceAt(x, z)`, see [modules/map/README.md](modules/map/README.md)). It is made
by rules over open data, with no model (`pipeline/landcover.py`):

- roads, paths, rail and rivers from OpenStreetMap lines, widened by the tagged or typical width; water, woods, parks and
  car parks from its areas
- trees from LiDAR canopy height (surface minus terrain) where there is LiDAR, outside buildings
- buildings from the footprints; bridges win over the water and rail beneath, roads win over the trees that overhang them
- anything left is guessed from colour (a green cast is grass, grey is paved, the rest bare)

Known weak spots: the colour guess cannot tell dull grass from tarmac in this imagery, so grass the OSM data does not map
(lawns, verges, gardens) is often called paved. A later phase will replace the guess with a segmentation model (issue #5).
In a 300 m box of Newtown the result is about 29% paved, 18% tree, 16% building, 13% grass, 12% road, 10% bare.

## Remove cars

Parked cars photographed from above end up flat on the road, so the pipeline can paint them out of the imagery:

```
.venv/bin/pip install -U pip && .venv/bin/pip install -r pipeline/requirements-cars.txt   # PyTorch comes with it; needs pip 22 or newer
.venv/bin/python -m pipeline.build_area --bbox 310725 291125 311025 291425 --id newtown-clean --remove-cars
REMOVE_CARS=0 .venv/bin/python modules/builder/server/serve.py                           # the build service removes cars by default once the detector is installed; 0 turns it off
```

A 300 m box takes about 20 s longer and found 212 cars in Newtown. The count is recorded in the bundle's `meta.json` as
`cars_removed`. Without `--remove-cars` nothing changes and PyTorch is not needed.

Design notes and data sources are in [PLAN.md](PLAN.md).

## Use it from another project

`npm install git+https://github.com/sergiomarrocoli/uk-map-3d.git#v0.1.0`, then import `uk-map-3d/map`, `uk-map-3d/flow` and
the other modules listed in `package.json`.

## Before going public

1. Settle the imagery licensing: read Esri's current terms (goto.arcgis.com/termsofuse), ask Esri, or switch the showcase
   to openly licensed aerial imagery.
2. No Esri imagery, and nothing built from it (screenshots, GIFs, demo bundles), in the repository or the README until then.
   The images in `docs/` were made from it and must be replaced or removed first.
3. Candidate demo places: Newtown (the area we know best), Silverstone (a real circuit, good for racing), Stonehenge.
