"""Welsh Government LiDAR (1 m DTM + DSM, 2020-23 survey) via the DataMapWales tile catalogue (PLAN §1).

Wales has no WCS, but the catalogue (a WFS layer of 1 km tiles) lists a direct GeoTIFF URL for every tile.
We look up the tiles under a bbox, cache them in `data/cache/wglidar/`, then mosaic and clip with the same
code used for user-supplied tiles (`dtm.dtm_from_files`).

Usage: python3 -m pipeline.wales_lidar --bbox 310700 291130 311200 291630 --out data/wales_dtm.tif [--dsm]
"""
import argparse
from datetime import datetime
from pathlib import Path

import requests

from pipeline.dtm import dtm_from_files
from pipeline.progress import download, say

WFS_URL = "https://datamap.gov.wales/geoserver/ows"
LAYER = "geonode:welsh_government_lidar_tile_catalogue_2020_2023"
CACHE = Path("data/cache/wglidar")
# The catalogue record's licence field says "Not Specified"; the DSM products are listed under the OGL. Verify before release.
ATTRIBUTION = "Contains Welsh Government LiDAR data © Welsh Government / Llywodraeth Cymru (OGL v3)"


def _date(s):
    try:
        return datetime.strptime(s, "%d-%m-%Y")
    except (TypeError, ValueError):
        return datetime.min


def catalogue_tiles(bbox):
    """Catalogue tiles overlapping `bbox` (EPSG:27700), one per grid reference (the latest delivery wins)."""
    resp = requests.get(WFS_URL, timeout=60, params={
        "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": LAYER,
        "outputFormat": "application/json", "srsName": "EPSG:27700",
        "bbox": ",".join(str(v) for v in bbox) + ",EPSG:27700"})
    resp.raise_for_status()
    min_e, min_n, max_e, max_n = bbox
    best = {}
    for f in resp.json()["features"]:
        ring = f["geometry"]["coordinates"][0]
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        # The WFS bbox filter also returns tiles that only touch the box's edge; skip those.
        if min(max(xs), max_e) - max(min(xs), min_e) < 0.5 or min(max(ys), max_n) - max(min(ys), min_n) < 0.5:
            continue
        p = f["properties"]
        grid = p["british_gr"]
        if grid not in best or _date(p.get("date")) > _date(best[grid].get("date")):
            best[grid] = p
    return [best[g] for g in sorted(best)]


def _download(url, dest, what=None):
    return download(url, dest, what)


def fetch_wales_lidar(bbox, out, kind="dtm", cache=CACHE):
    """Write a 1 m GeoTIFF of the Welsh `kind` ('dtm' or 'dsm') clipped to `bbox`; None if the catalogue has no tiles there."""
    if kind not in ("dtm", "dsm"):
        raise ValueError("kind must be 'dtm' or 'dsm'")
    tiles = [t for t in catalogue_tiles(bbox) if t.get(f"{kind}_link")]
    if not tiles:
        return None
    say(f"Welsh LiDAR: {len(tiles)} tile{'s cover' if len(tiles) != 1 else ' covers'} this area ({kind.upper()})")
    paths = []
    for i, t in enumerate(tiles, 1):
        name = Path(t[f"{kind}_link"]).name
        say(f"LiDAR tile {i} of {len(tiles)} ({kind.upper()}): {name}")
        paths.append(_download(t[f"{kind}_link"], Path(cache) / kind / name, name))
    return dtm_from_files(paths, bbox, out)


if __name__ == "__main__":
    from pipeline.dtm import summarise

    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("MINE", "MINN", "MAXE", "MAXN"))
    ap.add_argument("--out", default="data/wales_dtm.tif")
    ap.add_argument("--dsm", action="store_true")
    a = ap.parse_args()
    p = fetch_wales_lidar(a.bbox, a.out, "dsm" if a.dsm else "dtm")
    print(summarise(p) if p else "no Welsh Government LiDAR tiles cover this box")
