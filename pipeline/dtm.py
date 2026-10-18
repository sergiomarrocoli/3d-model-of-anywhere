"""Fetch a clipped 1 m DTM (and DSM) for a bbox in EPSG:27700 from the Environment Agency LiDAR Composite WCS.

Wales (NRW) LiDAR has no scriptable endpoint, so England is used for the M0 spike.
Usage: python3 -m pipeline.dtm --bbox 375000 164500 375500 165000 --out data/dtm.tif [--dsm]
"""
import argparse
from pathlib import Path

import numpy as np
import rasterio
import rasterio.enums
import requests

from pipeline.progress import say

WCS_URL = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m-2022/wcs"
COVERAGE_ID = "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"
DSM_WCS_URL = "https://environment.data.gov.uk/geoservices/datasets/df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb/wcs"
DSM_COVERAGE_ID = "df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m"
ATTRIBUTION = "Contains Environment Agency information © Environment Agency and/or database right (OGL v3)"


def fetch_dtm(bbox, out):
    """bbox = (minE, minN, maxE, maxN) in EPSG:27700 metres. Writes a GeoTIFF to `out`."""
    return _fetch_wcs(WCS_URL, COVERAGE_ID, bbox, out)


def fetch_dsm(bbox, out):
    """First-return DSM (includes buildings and trees) for the same box, same grid as the DTM."""
    return _fetch_wcs(DSM_WCS_URL, DSM_COVERAGE_ID, bbox, out)


def _fetch_wcs(wcs_url, coverage_id, bbox, out):
    min_e, min_n, max_e, max_n = bbox
    params = {
        "service": "WCS",
        "version": "2.0.1",
        "request": "GetCoverage",
        "coverageId": coverage_id,
        "format": "image/tiff",
    }
    # WCS 2.0 needs repeated `subset` params, which a dict can't express.
    query = list(params.items()) + [("subset", f"E({min_e},{max_e})"), ("subset", f"N({min_n},{max_n})")]
    say(f"Asking the Environment Agency for LiDAR ({coverage_id})")
    resp = requests.get(wcs_url, params=query, timeout=120)
    resp.raise_for_status()
    if "tiff" not in resp.headers.get("content-type", ""):
        raise RuntimeError(f"WCS returned {resp.headers.get('content-type')}: {resp.text[:300]}")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(resp.content)
    _mask_outside_coverage(out)
    return out


def _mask_outside_coverage(path):
    """The WCS returns exact 0.0 (not nodata) outside EA coverage, e.g. all of Wales; flag those pixels as nodata.

    Exactly 0.000 m is vanishingly rare in 1 m LiDAR, though a tidal flat at datum could lose a few pixels.
    """
    with rasterio.open(path) as ds:
        data, profile = ds.read(1), ds.profile
    nodata = profile.get("nodata")
    if nodata is None:
        nodata = profile["nodata"] = -9999.0
    zeros = data == 0.0
    if zeros.any():
        data[zeros] = nodata
        profile.update(compress="deflate")
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(data, 1)


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
    ap.add_argument("--dsm", action="store_true", help="fetch the first-return DSM instead of the DTM")
    args = ap.parse_args()
    path = (fetch_dsm if args.dsm else fetch_dtm)(args.bbox, args.out)
    print(summarise(path))


def dtm_from_files(paths, bbox, out, resolution=1.0):
    """Mosaic user-downloaded GeoTIFF tiles (e.g. NRW LiDAR, which has no scriptable endpoint) and clip to `bbox`.

    Pixels the tiles don't cover are left as nodata for `terrain_fill` to fill.
    """
    from rasterio.merge import merge

    min_e, min_n, max_e, max_n = bbox
    datasets = [rasterio.open(p) for p in paths]
    try:
        for ds in datasets:
            if str(ds.crs) != "EPSG:27700":
                raise ValueError(f"{ds.name} is {ds.crs}, expected EPSG:27700")
        data, transform = merge(datasets, bounds=tuple(bbox), res=resolution, nodata=-9999.0,
                                resampling=rasterio.enums.Resampling.bilinear)
    finally:
        for ds in datasets:
            ds.close()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=data.shape[2], height=data.shape[1], count=1, dtype="float32",
                       crs="EPSG:27700", transform=transform, nodata=-9999.0, compress="deflate") as dst:
        dst.write(data[0].astype("float32"), 1)
    return out
