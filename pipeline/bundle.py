"""Write the tile bundle the game client loads (PLAN §2).

    area_<id>/
      meta.json          bbox, origin, sizes, heightmap encoding, attribution
      heightmap.png      16-bit greyscale DTM; metres = min + (v / 65535) * (max - min)
      surfacemap.png     (optional) same encoding, LiDAR DSM on the DTM grid: ground + roofs + trees, never below the DTM
      landcover.png      (optional) 8-bit greyscale, one class id per 0.5 m cell (see pipeline/landcover.py CLASSES), rows north to south
      imagery.jpg        orthophoto clipped to the bbox
      buildings.geojson  local metre coords (origin = SW corner); props: base_z, height, ...
      ATTRIBUTION.txt    credits for every source used

Raster rows run north to south (row 0 is the northern edge), like the source GeoTIFFs. Heightmap
pixel (col, row) is the elevation at local x = col + 0.5, y = height - row - 0.5 (cell centres).
Local coordinates are metres east and north of the box's south-west corner, so floats stay small.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from shapely.affinity import translate
from shapely.geometry import mapping

from . import PIPELINE_VERSION
from .landcover import CLASSES

BUNDLE_VERSION = 1
BUILDING_PROPS = ("building", "osm_id", "height", "base_z", "height_source",
                  "building:levels", "building:material", "building:colour", "shop", "amenity")   # the last five dress the walls in the client
COORD_DECIMALS = 2  # centimetres


def encode_heightmap(z):
    """float array (NaN = none) -> (uint16 array, z_min, z_max)."""
    if not np.isfinite(z).all():
        raise ValueError("heightmap has nodata; run terrain_fill first")
    z_min, z_max = float(z.min()), float(z.max())
    span = z_max - z_min or 1.0
    return np.round((z - z_min) / span * 65535).astype("uint16"), z_min, z_max


def decode_heightmap(png_path, z_min, z_max):
    v = np.asarray(Image.open(png_path)).astype("float64")
    return z_min + v / 65535 * (z_max - z_min)


def _local_buildings(gdf, origin):
    ox, oy = origin
    feats = []
    for _, row in gdf.iterrows():
        geom = translate(row.geometry, -ox, -oy)
        props = {k: (None if _isnull(row.get(k)) else _py(row[k])) for k in BUILDING_PROPS if k in gdf.columns}
        feats.append({"type": "Feature", "properties": props, "geometry": _round(mapping(geom))})
    return {"type": "FeatureCollection", "features": feats}


def _isnull(v):
    return v is None or (isinstance(v, float) and np.isnan(v))


def _py(v):
    return v.item() if hasattr(v, "item") else v


def _round(obj):
    if isinstance(obj, (list, tuple)):
        return [_round(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _round(v) for k, v in obj.items()}
    if isinstance(obj, float):
        return round(obj, COORD_DECIMALS)
    return obj


def surface_from_dsm(dsm_path, dtm_path, z_ground):
    """DSM resampled onto the DTM grid, with gaps filled from the ground and never below it."""
    from rasterio.warp import Resampling, reproject

    with rasterio.open(dtm_path) as dtm, rasterio.open(dsm_path) as dsm:
        out = np.full((dtm.height, dtm.width), np.nan, dtype="float64")
        reproject(rasterio.band(dsm, 1), out, src_nodata=dsm.nodata, dst_transform=dtm.transform, dst_crs=dtm.crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear)
    out = np.where(np.isfinite(out), out, z_ground)
    return np.maximum(out, z_ground)


def write_bundle(out_dir, area_id, dtm_path, imagery_path, buildings, attributions, dsm_path=None, landcover=None):
    """Write a bundle into `out_dir/area_<area_id>/` and return its path.

    `dtm_path` and `imagery_path` must share one extent (EPSG:27700); `buildings` is a GeoDataFrame
    in EPSG:27700 with `height` and `base_z` columns.
    """
    if str(buildings.crs) != "EPSG:27700":
        raise ValueError(f"buildings must be EPSG:27700, got {buildings.crs}")
    root = Path(out_dir) / f"area_{area_id}"
    root.mkdir(parents=True, exist_ok=True)

    with rasterio.open(dtm_path) as dtm, rasterio.open(imagery_path) as img:
        if not np.allclose(tuple(dtm.bounds), tuple(img.bounds), atol=1e-6):
            raise ValueError(f"DTM {tuple(dtm.bounds)} and imagery {tuple(img.bounds)} cover different extents")
        b = dtm.bounds
        z = dtm.read(1, masked=True).astype("float64").filled(np.nan)
        rgb = np.moveaxis(img.read(), 0, -1)
        dtm_size, img_size, res = (dtm.width, dtm.height), (img.width, img.height), dtm.res

    codes, z_min, z_max = encode_heightmap(z)
    Image.fromarray(codes).save(root / "heightmap.png")
    surface = None
    if dsm_path is not None:
        zs = surface_from_dsm(dsm_path, dtm_path, z)
        scodes, s_min, s_max = encode_heightmap(zs)
        Image.fromarray(scodes).save(root / "surfacemap.png")
        surface = {"file": "surfacemap.png", "width": dtm_size[0], "height": dtm_size[1], "resolution_m": res[0],
                   "bits": 16, "min": s_min, "max": s_max}
    elif (root / "surfacemap.png").exists():
        (root / "surfacemap.png").unlink()  # stale file from an earlier build of this id
    Image.fromarray(rgb).save(root / "imagery.jpg", quality=90)
    land = None
    if landcover is not None:
        grid, info = landcover
        Image.fromarray(grid, "L").save(root / "landcover.png", optimize=True)
        land = {"file": "landcover.png", "width": grid.shape[1], "height": grid.shape[0], "resolution_m": info["resolution_m"],
                "classes": {str(k): v for k, v in CLASSES.items()}, "share": info["share"], "canopy_from_lidar": info["canopy_from_lidar"]}
    elif (root / "landcover.png").exists():
        (root / "landcover.png").unlink()  # stale file from an earlier build of this id

    origin = (b.left, b.bottom)
    fc = _local_buildings(buildings, origin)
    (root / "buildings.geojson").write_text(json.dumps(fc, separators=(",", ":")))

    credits = list(dict.fromkeys(attributions))  # dedupe, keep order
    (root / "ATTRIBUTION.txt").write_text("\n".join(credits) + "\n")

    meta = {
        "version": BUNDLE_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "id": str(area_id),
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "crs": "EPSG:27700",
        "bbox": [b.left, b.bottom, b.right, b.top],
        "origin": [b.left, b.bottom],
        "size_m": [b.right - b.left, b.top - b.bottom],
        "heightmap": {"file": "heightmap.png", "width": dtm_size[0], "height": dtm_size[1], "resolution_m": res[0],
                      "bits": 16, "min": z_min, "max": z_max},
        **({"surfacemap": surface} if surface else {}),
        **({"landcover": land} if land else {}),
        "imagery": {"file": "imagery.jpg", "width": img_size[0], "height": img_size[1]},
        "buildings": {"file": "buildings.geojson", "count": len(fc["features"]),
                      "coords": "local metres from the south-west corner"},
        "attribution": credits,
    }
    (root / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    return root


def load_bundle(path):
    """Read a bundle back: (meta, heightmap metres array, RGB array, buildings FeatureCollection)."""
    root = Path(path)
    meta = json.loads((root / "meta.json").read_text())
    hm = meta["heightmap"]
    z = decode_heightmap(root / hm["file"], hm["min"], hm["max"])
    rgb = np.asarray(Image.open(root / meta["imagery"]["file"]).convert("RGB"))
    fc = json.loads((root / meta["buildings"]["file"]).read_text())
    return meta, z, rgb, fc
