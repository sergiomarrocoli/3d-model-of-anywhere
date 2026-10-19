"""Land cover: a class for every half metre of an area (road, grass, water, tree...), so a game can ask what is under a wheel.

Phase 1 is rules over open data, no model:
  OpenStreetMap   roads, paths, rail and rivers (lines, widened by their tagged or typical width), water, woods, parks,
                  parking and other areas (polygons)
  LiDAR           canopy height (surface minus terrain) marks trees where OSM has not mapped a wood; needs a DSM
  the footprints  buildings
  the imagery     colour decides what none of that covers (a green cast is grass, grey is paved, the rest bare)
Layers are painted in this order, the last one winning: imagery guess, grass and bare areas, trees, tracks and rail, paved
areas, paths, roads, water, buildings, bridges. Roads win over the trees that overhang them (the ground under a canopy is
still road); bridges win over the water and rail beneath.

The result is a uint8 raster, rows north to south like the other bundle rasters, one class id per cell (CLASSES below).
"""
import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import rasterize, sieve
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject
from shapely.geometry import LineString, box
from shapely.ops import transform

from pipeline import buildings as osm

UNKNOWN, ROAD, PAVED, GRASS, BARE, TREE, WATER, BUILDING = range(8)
CLASSES = {UNKNOWN: "unknown", ROAD: "road", PAVED: "paved", GRASS: "grass", BARE: "bare", TREE: "tree", WATER: "water",
           BUILDING: "building"}
RES_M = 0.5
CANOPY_MIN_M = 2.5          # surface this far above the terrain, outside buildings, is a tree
MIN_BLOB_CELLS = 12         # 3 m2: smaller islands of a guessed class are noise
ATTRIBUTION = osm.ATTRIBUTION

ROAD_WIDTH = {"motorway": 14, "trunk": 12, "primary": 10, "secondary": 9, "tertiary": 8, "unclassified": 6, "residential": 6,
              "living_street": 5, "service": 3.5, "raceway": 12, "road": 5, "motorway_link": 7, "trunk_link": 7,
              "primary_link": 6, "secondary_link": 6, "tertiary_link": 5}
PATH_WIDTH = {"footway": 2, "pedestrian": 4, "cycleway": 2.5, "path": 1.5, "steps": 2, "corridor": 2, "bridleway": 2.5, "track": 3}
WATERWAY_WIDTH = {"river": 8, "canal": 6, "stream": 2.5, "drain": 1.5, "ditch": 1.5}
UNPAVED = {"unpaved", "dirt", "ground", "earth", "mud", "gravel", "fine_gravel", "grass", "sand", "compacted", "pebblestone", "woodchips"}
PAVED_SURFACE = {"paved", "asphalt", "concrete", "paving_stones", "sett", "cobblestone", "concrete:plates", "tartan", "metal"}
HIDDEN = {"yes", "culvert", "building_passage", "covered"}   # tunnels: not on the surface
BRIDGE = {"yes", "viaduct", "aqueduct", "boardwalk", "movable", "cantilever", "suspension"}

GRASS_LANDUSE = {"grass", "meadow", "farmland", "farmyard", "orchard", "vineyard", "allotments", "cemetery", "village_green",
                 "recreation_ground", "greenfield", "flowerbed", "plant_nursery"}
GRASS_NATURAL = {"grassland", "heath", "wetland", "fell", "moor"}
GRASS_LEISURE = {"park", "garden", "pitch", "golf_course", "recreation_ground", "common", "nature_reserve", "village_green",
                 "playground", "dog_park", "track"}
BARE_NATURAL = {"sand", "beach", "bare_rock", "scree", "shingle", "mud", "dune", "rock", "cliff"}
BARE_LANDUSE = {"quarry", "construction", "brownfield", "landfill", "railway"}


def area_class(tags):
    """Class of a mapped area (a closed way or multipolygon), or None when its tags say nothing about the ground."""
    natural, landuse, leisure = tags.get("natural"), tags.get("landuse"), tags.get("leisure")
    if natural == "water" or tags.get("water") or tags.get("waterway") == "riverbank" or landuse in ("reservoir", "basin"):
        return WATER
    if natural in ("wood", "scrub") or landuse == "forest":
        return TREE
    surface = tags.get("surface")
    if tags.get("area:highway") or tags.get("amenity") == "parking" or (tags.get("highway") in ("pedestrian", "footway") and tags.get("area") == "yes"):
        return BARE if surface in UNPAVED else PAVED
    if leisure in ("pitch", "playground") and surface in PAVED_SURFACE:
        return PAVED
    if natural in BARE_NATURAL or landuse in BARE_LANDUSE or (leisure in GRASS_LEISURE and surface in UNPAVED - {"grass"}):
        return BARE
    if landuse in GRASS_LANDUSE or natural in GRASS_NATURAL or leisure in GRASS_LEISURE:
        return GRASS
    return None


def line_class(tags):
    """(class, width in metres, is a bridge) for a mapped line, or None. Tunnels and unfinished roads have no surface class."""
    layer = tags.get("layer", "0")
    hidden = tags.get("tunnel") in HIDDEN or layer.lstrip("-").isdigit() and int(layer) < 0
    bridge = tags.get("bridge") in BRIDGE
    highway, waterway, railway, surface = tags.get("highway"), tags.get("waterway"), tags.get("railway"), tags.get("surface")
    if hidden or tags.get("area") == "yes":
        return None
    if highway in ROAD_WIDTH or highway in PATH_WIDTH:
        width = _width(tags, ROAD_WIDTH.get(highway) or PATH_WIDTH[highway])
        if highway in ROAD_WIDTH and surface not in UNPAVED:
            return ROAD, width, bridge
        if highway in ROAD_WIDTH or highway in ("track", "bridleway") or surface in UNPAVED or tags.get("tracktype") not in (None, "grade1"):
            return BARE, width, bridge
        return PAVED, width, bridge
    if waterway in WATERWAY_WIDTH:
        return WATER, _width(tags, WATERWAY_WIDTH[waterway]), False
    if railway in ("rail", "light_rail", "narrow_gauge", "tram", "preserved"):
        return BARE, 3.5, bridge
    if tags.get("natural") == "tree_row":
        return TREE, 3, False
    return None


def _width(tags, default):
    for key in ("width", "est_width"):
        try:
            return max(0.5, float(str(tags[key]).split()[0].replace("m", "")))
        except (KeyError, ValueError):
            pass
    try:
        return max(default, 3.0 * float(tags["lanes"]))
    except (KeyError, ValueError):
        return default


def query(bbox):
    """The Overpass query for everything that says what the ground is (its text is the disk cache's key)."""
    s, w, n, e = osm._to_wgs84_bbox(bbox)
    area = f"({s},{w},{n},{e})"
    keys = ['"highway"', '"waterway"', '"railway"', '"natural"', '"water"', '"landuse"', '"leisure"', '"amenity"="parking"', '"area:highway"']
    parts = [f"way[{k}]{area};" for k in keys] + [f'relation["type"="multipolygon"]["{k}"]{area};' for k in ("natural", "water", "landuse", "leisure", "amenity")]
    return f'[out:json][timeout:90];({"".join(parts)});out geom;'


def fetch_elements(bbox):
    return osm._overpass(query(bbox), what="roads, water and woods").json()["elements"]


def shapes(elements):
    """Sort Overpass elements into [(class, geometry in EPSG:27700, is_bridge)], areas and lines apart.

    Returns (areas, lines): each a list of (class, shapely geometry, bridge).
    """
    to_bng = Transformer.from_crs("EPSG:4326", osm.CRS, always_xy=True).transform
    areas, lines = [], []
    for el in elements:
        tags = el.get("tags", {})
        cls = area_class(tags)
        if cls is not None and (el["type"] == "relation" or _closed(el)):
            for ring in osm._rings(el):
                if not ring.is_empty:
                    areas.append((cls, transform(to_bng, ring), False))
            continue
        spec = line_class(tags) if el["type"] == "way" else None
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        if spec and len(pts) >= 2:
            klass, width, bridge = spec
            lines.append((klass, transform(to_bng, LineString(pts)).buffer(width / 2, cap_style=2), bridge))
    return areas, lines


def _closed(el):
    pts = el.get("geometry", [])
    return el["type"] == "way" and len(pts) >= 4 and pts[0] == pts[-1]


def _paint(arr, geoms, value, transform_):
    geoms = [g for g in geoms if not g.is_empty]
    if geoms:
        mask = rasterize([(g, 1) for g in geoms], out_shape=arr.shape, transform=transform_, fill=0, dtype="uint8")
        arr[mask == 1] = value


def guess_from_imagery(rgb):
    """A class for every cell from colour alone, using ratios so that ground in shadow is still told apart: a green cast is
    grass, grey is paved, a warm brown or tan is bare. Only near-black cells stay unknown."""
    r, g, b = (rgb[..., i].astype("float32") for i in range(3))
    total = r + g + b + 1.0
    green_share = g / total
    top = rgb.max(axis=-1).astype("float32")
    saturation = (top - rgb.min(axis=-1)) / (top + 1.0)
    out = np.full(r.shape, BARE, np.uint8)
    out[saturation < 0.22] = PAVED
    out[(green_share > 0.385) & (g >= r) & (g >= b)] = GRASS
    out[total < 45] = UNKNOWN
    return out


def _grid(path, transform_, shape, resampling=Resampling.bilinear):
    out = np.full(shape, np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(rasterio.band(src, 1), out, src_nodata=src.nodata, dst_transform=transform_, dst_crs=osm.CRS,
                  dst_nodata=np.nan, resampling=resampling)
    return out


def build_landcover(dtm_path, imagery_path, buildings, dsm_path=None, elements=None, bbox=None):
    """(uint8 raster, info). The grid is the DTM's extent at RES_M, rows north to south. `buildings` is a GeoDataFrame in
    EPSG:27700 (may be empty). `elements` are Overpass elements (fetched for `bbox`, default the DTM's, when not given).
    With `imagery_path=None` (no photo, as for a stylised texture) there is no colour guess: whatever the map data does not cover is grass."""
    with rasterio.open(dtm_path) as dtm:
        left, bottom, right, top = dtm.bounds
    width, height = round((right - left) / RES_M), round((top - bottom) / RES_M)
    tf = from_bounds(left, bottom, right, top, width, height)
    if elements is None:
        elements = fetch_elements(bbox or (left, bottom, right, top))
    areas, lines = shapes(elements)

    if imagery_path is None:
        arr = np.full((height, width), GRASS, np.uint8)
    else:
        with rasterio.open(imagery_path) as src:
            rgb = np.moveaxis(src.read(out_shape=(3, height, width), resampling=Resampling.average), 0, -1)
        arr = sieve(guess_from_imagery(rgb), MIN_BLOB_CELLS, connectivity=4)

    def of(items, cls, bridge=None):
        return [g for c, g, b in items if c == cls and (bridge is None or b == bridge)]

    _paint(arr, of(areas, GRASS), GRASS, tf)
    _paint(arr, of(areas, BARE), BARE, tf)
    has_canopy = dsm_path is not None
    footprints = list(buildings.geometry) if len(buildings) else []
    if has_canopy:
        canopy = _grid(dsm_path, tf, arr.shape) - _grid(dtm_path, tf, arr.shape)
        trees = (np.nan_to_num(canopy, nan=0.0) > CANOPY_MIN_M).astype("uint8")
        if footprints:
            _paint(trees, footprints, 0, tf)
        arr[sieve(trees, MIN_BLOB_CELLS, connectivity=4) == 1] = TREE
    _paint(arr, of(areas, TREE) + of(lines, TREE), TREE, tf)
    _paint(arr, of(lines, BARE, bridge=False), BARE, tf)
    _paint(arr, of(areas, PAVED), PAVED, tf)
    _paint(arr, of(lines, PAVED, bridge=False), PAVED, tf)
    _paint(arr, of(lines, ROAD, bridge=False), ROAD, tf)
    _paint(arr, of(areas, WATER) + of(lines, WATER), WATER, tf)
    _paint(arr, footprints, BUILDING, tf)
    _paint(arr, of(lines, BARE, bridge=True), BARE, tf)
    _paint(arr, of(lines, PAVED, bridge=True), PAVED, tf)
    _paint(arr, of(lines, ROAD, bridge=True), ROAD, tf)

    share = {CLASSES[c]: round(float((arr == c).mean()), 4) for c in CLASSES if (arr == c).any()}
    return arr, {"resolution_m": RES_M, "width": width, "height": height, "share": share, "canopy_from_lidar": has_canopy,
                 "osm_elements": len(elements)}
