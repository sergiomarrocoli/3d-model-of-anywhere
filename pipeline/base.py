"""Set each building's base elevation to the minimum DTM height under its footprint (PLAN §3.6).

Adds `base_z` (m above datum). A building's roof is then base_z + height, and the game extrudes
from base_z, so buildings sit into slopes instead of floating.
Usage: python3 -m pipeline.base --buildings data/buildings_heights.geojson --dtm data/dtm.tif
"""
import argparse

import geopandas as gpd
import numpy as np
import rasterio

from pipeline.heights import footprint_values


def assign_base(gdf, dtm_path):
    out = gdf.copy()
    with rasterio.open(dtm_path) as dtm:
        z = dtm.read(1, masked=True).astype("float64").filled(np.nan)
        transform, shape = dtm.transform, dtm.shape
    base = []
    for g in out.geometry:
        vals = footprint_values(g, z, transform, shape)
        base.append(float(vals.min()) if vals.size else np.nan)
    out["base_z"] = np.round(base, 2)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--buildings", default="data/buildings_heights.geojson")
    ap.add_argument("--dtm", default="data/dtm.tif")
    ap.add_argument("--out", default="data/buildings_base.geojson")
    a = ap.parse_args()
    res = assign_base(gpd.read_file(a.buildings), a.dtm)
    res.to_file(a.out, driver="GeoJSON")
    print({"count": len(res), "missing": int(res.base_z.isna().sum()),
           "base_z": res.base_z.describe().round(1).to_dict()})
