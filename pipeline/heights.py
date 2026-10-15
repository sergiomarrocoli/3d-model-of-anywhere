"""Assign a height to each building footprint (PLAN §3.5).

Order of preference:
  1. 90th percentile of (DSM - DTM) inside the footprint ("lidar")
  2. OSM `height`, or `building:levels` x 3 m ("osm")
  3. a default of 6 m ("default")

Adds `height` (m) and `height_source` columns.
Usage: python3 -m pipeline.heights --buildings data/buildings_clean.geojson --dtm data/dtm.tif --dsm data/dsm.tif
"""
import argparse
import re

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import geometry_mask

DEFAULT_HEIGHT_M = 6.0
LEVEL_HEIGHT_M = 3.0
# A building cannot be lower than this; smaller nDSM values mean the LiDAR hit the ground,
# a low shed, or a DSM/DTM mismatch, so we fall through to the OSM tags instead.
MIN_LIDAR_HEIGHT_M = 2.0
MAX_HEIGHT_M = 200.0


def parse_osm_height(value):
    """'12', '12.5', '12 m', '12m' -> float metres; anything else (feet, ranges, junk) -> None."""
    if value is None:
        return None
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(m)?\s*", str(value))
    return float(m.group(1)) if m else None


def osm_height(height, levels):
    h = parse_osm_height(height)
    if h and h > 0:
        return h
    try:
        n = float(levels)
    except (TypeError, ValueError):
        return None
    return n * LEVEL_HEIGHT_M if n > 0 else None


def footprint_values(geom, array, transform, shape):
    """Finite raster values whose pixel centres fall inside `geom` (any touched pixel if none do)."""
    vals = array[~geometry_mask([geom], shape, transform, all_touched=False)]
    if vals.size == 0:  # footprint smaller than a pixel centre
        vals = array[~geometry_mask([geom], shape, transform, all_touched=True)]
    return vals[np.isfinite(vals)]


def lidar_heights(geoms, dtm_path, dsm_path):
    """90th percentile of nDSM = DSM - DTM inside each footprint (NaN where there is no valid data)."""
    with rasterio.open(dtm_path) as dtm, rasterio.open(dsm_path) as dsm:
        if dtm.transform != dsm.transform or dtm.shape != dsm.shape:
            raise ValueError("DTM and DSM must be on the same grid")
        ndsm = (dsm.read(1, masked=True).astype("float64") - dtm.read(1, masked=True).astype("float64")).filled(np.nan)
        transform, shape = dtm.transform, dtm.shape
    out = []
    for g in geoms:
        vals = footprint_values(g, ndsm, transform, shape)
        out.append(float(np.percentile(vals, 90)) if vals.size else np.nan)
    return np.array(out)


def assign_heights(gdf, dtm_path, dsm_path=None):
    """`dsm_path=None` skips the LiDAR step (no surface model for the area), leaving OSM tags then the default."""
    out = gdf.copy()
    lidar = lidar_heights(out.geometry, dtm_path, dsm_path) if dsm_path else np.full(len(out), np.nan)
    heights, sources = [], []
    for i, (_, row) in enumerate(out.iterrows()):
        l = lidar[i]
        if np.isfinite(l) and MIN_LIDAR_HEIGHT_M <= l <= MAX_HEIGHT_M:
            heights.append(l); sources.append("lidar")
            continue
        o = osm_height(row.get("height"), row.get("building:levels"))
        if o:
            heights.append(o); sources.append("osm")
        else:
            heights.append(DEFAULT_HEIGHT_M); sources.append("default")
    out["osm_height"] = out.get("height")  # keep the raw tag; `height` becomes our computed metres
    out["height"] = np.round(heights, 2)
    out["height_source"] = sources
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--buildings", default="data/buildings_clean.geojson")
    ap.add_argument("--dtm", default="data/dtm.tif")
    ap.add_argument("--dsm", default="data/dsm.tif")
    ap.add_argument("--out", default="data/buildings_heights.geojson")
    a = ap.parse_args()
    res = assign_heights(gpd.read_file(a.buildings), a.dtm, a.dsm)
    res.to_file(a.out, driver="GeoJSON")
    print(res.height_source.value_counts().to_dict(), res.height.describe().round(1).to_dict())
