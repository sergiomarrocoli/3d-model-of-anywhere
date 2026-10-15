"""Fetch a clipped 1 m DTM for a bbox in EPSG:27700 from the Environment Agency LiDAR Composite WCS.

Wales (NRW) LiDAR has no scriptable endpoint, so England is used for the M0 spike.
Usage: python3 -m pipeline.dtm --bbox 375000 164500 375500 165000 --out data/dtm.tif
"""
import argparse
from pathlib import Path

import numpy as np
import rasterio
import requests

WCS_URL = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m-2022/wcs"
COVERAGE_ID = "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"
ATTRIBUTION = "Contains Environment Agency information © Environment Agency and/or database right (OGL v3)"


def fetch_dtm(bbox, out):
    """bbox = (minE, minN, maxE, maxN) in EPSG:27700 metres. Writes a GeoTIFF to `out`."""
    min_e, min_n, max_e, max_n = bbox
    params = {
        "service": "WCS",
        "version": "2.0.1",
        "request": "GetCoverage",
        "coverageId": COVERAGE_ID,
        "format": "image/tiff",
    }
    # WCS 2.0 needs repeated `subset` params, which a dict can't express.
    query = list(params.items()) + [("subset", f"E({min_e},{max_e})"), ("subset", f"N({min_n},{max_n})")]
    resp = requests.get(WCS_URL, params=query, timeout=120)
    resp.raise_for_status()
    if "tiff" not in resp.headers.get("content-type", ""):
        raise RuntimeError(f"WCS returned {resp.headers.get('content-type')}: {resp.text[:300]}")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(resp.content)
    return out


def summarise(path):
    with rasterio.open(path) as ds:
        a = ds.read(1, masked=True)
        return {
            "crs": str(ds.crs),
            "size": (ds.width, ds.height),
            "res": ds.res,
            "bounds": tuple(ds.bounds),
            "min": float(a.min()),
            "max": float(a.max()),
            "nodata_pct": float(np.ma.getmaskarray(a).mean() * 100),
        }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("MINE", "MINN", "MAXE", "MAXN"))
    ap.add_argument("--out", default="data/dtm.tif")
    args = ap.parse_args()
    path = fetch_dtm(args.bbox, args.out)
    print(summarise(path))
