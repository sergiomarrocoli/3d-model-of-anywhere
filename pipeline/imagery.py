"""Fetch aerial imagery for a bbox in EPSG:27700, stitched and clipped to exactly that extent.

Sources sit behind `ImagerySource` so they can be swapped (see PLAN §1). Esri World Imagery is for
local development only: it is NOT licensed for a distributed game.

Usage: python3 -m pipeline.imagery --bbox 375000 164500 375500 165000 --out data/imagery.tif
"""
import argparse
import io
import math
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image
from pyproj import Transformer
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

CRS = "EPSG:27700"
WEBMERC_HALF = 20037508.342789244
TILE = 256


class ImagerySource(ABC):
    attribution: str

    @abstractmethod
    def fetch(self, bbox) -> tuple[np.ndarray, rasterio.Affine, str]:
        """Return (HxWx3 uint8 array, affine transform, crs string) covering at least `bbox` (EPSG:27700)."""


class XYZTileSource(ImagerySource):
    """Web Mercator XYZ tile server."""

    def __init__(self, url_template, zoom, attribution):
        self.url_template, self.zoom, self.attribution = url_template, zoom, attribution

    def fetch(self, bbox):
        to_merc = Transformer.from_crs(CRS, "EPSG:3857", always_xy=True)
        min_e, min_n, max_e, max_n = bbox
        xs, ys = zip(*(to_merc.transform(e, n) for e in (min_e, max_e) for n in (min_n, max_n)))
        n = 2 ** self.zoom
        size = 2 * WEBMERC_HALF / n

        def tile_x(x): return int((x + WEBMERC_HALF) // size)
        def tile_y(y): return int((WEBMERC_HALF - y) // size)

        x0, x1 = tile_x(min(xs)), tile_x(max(xs))
        y0, y1 = tile_y(max(ys)), tile_y(min(ys))
        coords = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]

        with ThreadPoolExecutor(max_workers=8) as pool:
            tiles = dict(zip(coords, pool.map(self._get, coords)))

        mosaic = np.zeros(((y1 - y0 + 1) * TILE, (x1 - x0 + 1) * TILE, 3), dtype=np.uint8)
        for (x, y), img in tiles.items():
            r, c = (y - y0) * TILE, (x - x0) * TILE
            mosaic[r:r + TILE, c:c + TILE] = img
        west = -WEBMERC_HALF + x0 * size
        north = WEBMERC_HALF - y0 * size
        transform = rasterio.Affine(size / TILE, 0, west, 0, -size / TILE, north)
        return mosaic, transform, "EPSG:3857"

    def _get(self, xy):
        x, y = xy
        url = self.url_template.format(z=self.zoom, x=x, y=y)
        for attempt in range(3):
            try:
                r = requests.get(url, timeout=30, headers={"User-Agent": "civil-war-prototype"})
                r.raise_for_status()
                return np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))
            except (requests.RequestException, OSError):
                if attempt == 2:
                    raise


def esri_world_imagery(zoom=19):
    return XYZTileSource(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        zoom,
        "Source: Esri, Maxar, Earthstar Geographics (development use only)",
    )


def fetch_imagery(bbox, out, size=None, source=None):
    """Write an RGB GeoTIFF in EPSG:27700 clipped to exactly `bbox`.

    `size` is the output edge in pixels (default: ~0.25 m/px, e.g. 2048 for 500 m).
    """
    source = source or esri_world_imagery()
    min_e, min_n, max_e, max_n = bbox
    width = size or round((max_e - min_e) / 0.25 / 64) * 64 or 64
    height = size or round((max_n - min_n) / 0.25 / 64) * 64 or 64
    src, src_transform, src_crs = source.fetch(bbox)
    dst_transform = from_bounds(min_e, min_n, max_e, max_n, width, height)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=width, height=height, count=3, dtype="uint8",
                       crs=CRS, transform=dst_transform, photometric="RGB", compress="deflate") as dst:
        for band in range(3):
            reproject(src[:, :, band], rasterio.band(dst, band + 1),
                      src_transform=src_transform, src_crs=src_crs,
                      dst_transform=dst_transform, dst_crs=CRS, resampling=Resampling.bilinear)
    return out


def summarise(path):
    with rasterio.open(path) as ds:
        a = ds.read()
        return {"crs": str(ds.crs), "size": (ds.width, ds.height), "res": tuple(round(r, 3) for r in ds.res),
                "bounds": tuple(ds.bounds), "blank_pct": round(float((a.max(axis=0) == 0).mean() * 100), 3)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("MINE", "MINN", "MAXE", "MAXN"))
    ap.add_argument("--out", default="data/imagery.tif")
    ap.add_argument("--size", type=int, help="output edge in pixels (default ~0.25 m/px)")
    ap.add_argument("--jpg", action="store_true", help="also write a preview JPEG next to the GeoTIFF")
    args = ap.parse_args()
    path = fetch_imagery(args.bbox, args.out, args.size)
    if args.jpg:
        with rasterio.open(path) as ds:
            Image.fromarray(np.moveaxis(ds.read(), 0, -1)).save(Path(path).with_suffix(".jpg"), quality=90)
    print(summarise(path))
