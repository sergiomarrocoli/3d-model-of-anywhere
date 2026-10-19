"""Fill DTM nodata from OS Terrain 50 and resample to a 1 m grid (PLAN §3.1, §5).

OS Terrain 50 (50 m, OGL) is only published as one GB-wide zip, so it is downloaded once into
`data/cache/terr50/` and single 10 km tiles are read out of it on demand.

Usage: python3 -m pipeline.terrain_fill --dtm data/dtm.tif --out data/dtm_filled.tif
"""
import argparse
import io
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import requests

from pipeline.progress import download
from rasterio.io import MemoryFile
from rasterio.merge import merge
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

CRS = "EPSG:27700"
CACHE = Path("data/cache/terr50")
ZIP_NAME = "terr50_gagg_gb.zip"
ZIP_URL = ("https://api.os.uk/downloads/v1/products/Terrain50/downloads"
           "?area=GB&format=ASCII+Grid+and+GML+%28Grid%29&redirect")
ZIP_MD5 = "feba9008db55cdcb5c5e5b7896e3428b"  # listed by the OS Downloads API; the zip is rebuilt periodically
ATTRIBUTION = "Contains OS data © Crown copyright and database right (OGL v3)"
GRID_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"  # OS grid skips I


def tile_name(easting, northing):
    """10 km OS tile name, e.g. (375000, 164500) -> 'st76'."""
    e100, n100 = int(easting // 100_000), int(northing // 100_000)
    l1 = (19 - n100) - (19 - n100) % 5 + (e100 + 10) // 5
    l2 = ((19 - n100) * 5) % 25 + e100 % 5
    e10, n10 = int(easting % 100_000 // 10_000), int(northing % 100_000 // 10_000)
    return f"{GRID_LETTERS[l1]}{GRID_LETTERS[l2]}{e10}{n10}".lower()


def tiles_for_bbox(bbox):
    min_e, min_n, max_e, max_n = bbox
    e0, e1 = int(min_e // 10_000), int(-(-max_e // 10_000)) - 1  # max edge is exclusive
    n0, n1 = int(min_n // 10_000), int(-(-max_n // 10_000)) - 1
    return [tile_name(e * 10_000, n * 10_000) for e in range(e0, max(e0, e1) + 1) for n in range(n0, max(n0, n1) + 1)]


def ensure_zip(cache=CACHE):
    return download(ZIP_URL, Path(cache) / ZIP_NAME, "OS Terrain 50 (the height data for gaps in the LiDAR)")


def _read_tile(zf, name):
    member = next((n for n in zf.namelist() if Path(n).name.lower().startswith(name + "_ost50grid")), None)
    if member is None:
        return None  # sea / outside GB
    inner = zipfile.ZipFile(io.BytesIO(zf.read(member)))
    asc = next(n for n in inner.namelist() if n.lower().endswith(".asc"))
    return inner.read(asc)


def terrain50(bbox, cache=CACHE):
    """Return (array, transform) of Terrain 50 covering `bbox`, as float32 in EPSG:27700."""
    zf = zipfile.ZipFile(ensure_zip(cache))
    datasets, memfiles = [], []
    for name in tiles_for_bbox(bbox):
        data = _read_tile(zf, name)
        if data is None:
            continue
        mf = MemoryFile(data)
        memfiles.append(mf)
        datasets.append(mf.open(driver="AAIGrid"))
    if not datasets:
        raise RuntimeError(f"No Terrain 50 tiles for {bbox}")
    mosaic, transform = merge(datasets, nodata=-9999)
    for ds in datasets:
        ds.close()
    for mf in memfiles:
        mf.close()
    arr = mosaic[0].astype("float32")
    arr[arr == -9999] = np.nan
    return arr, transform


def fill_dtm(dtm_path, out, cache=CACHE, resolution=1.0):
    """Write a gap-free DTM on a `resolution`-metre grid covering the same bounds as `dtm_path`.

    Pixels with data come from the LiDAR DTM (resampled bilinear if its grid isn't already
    `resolution`); nodata pixels are filled with bilinearly interpolated Terrain 50.
    Returns the fraction of pixels that were filled.
    """
    with rasterio.open(dtm_path) as src:
        b = src.bounds
        width, height = round((b.right - b.left) / resolution), round((b.top - b.bottom) / resolution)
        dst_transform = from_bounds(b.left, b.bottom, b.right, b.top, width, height)
        lidar = np.full((height, width), np.nan, dtype="float32")
        data = src.read(1, masked=True).astype("float32").filled(np.nan)
        reproject(data, lidar, src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=dst_transform, dst_crs=CRS, dst_nodata=np.nan, resampling=Resampling.bilinear)

    gaps = ~np.isfinite(lidar)
    filled_fraction = float(gaps.mean())
    if gaps.any():
        # Pad the bbox so bilinear interpolation at the edges has neighbouring Terrain 50 cells.
        pad = 100
        t50, t50_transform = terrain50((b.left - pad, b.bottom - pad, b.right + pad, b.top + pad), cache)
        coarse = np.full((height, width), np.nan, dtype="float32")
        reproject(t50, coarse, src_transform=t50_transform, src_crs=CRS, src_nodata=np.nan,
                  dst_transform=dst_transform, dst_crs=CRS, dst_nodata=np.nan, resampling=Resampling.bilinear)
        lidar[gaps] = coarse[gaps]

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=width, height=height, count=1, dtype="float32",
                       crs=CRS, transform=dst_transform, nodata=np.nan, compress="deflate") as dst:
        dst.write(lidar, 1)
    return filled_fraction


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dtm", default="data/dtm.tif")
    ap.add_argument("--out", default="data/dtm_filled.tif")
    ap.add_argument("--resolution", type=float, default=1.0)
    a = ap.parse_args()
    frac = fill_dtm(a.dtm, a.out, resolution=a.resolution)
    print(f"filled {frac:.1%} of pixels from Terrain 50 -> {a.out}")
