"""End-to-end pipeline: bbox in, tile bundle out (PLAN §3).

Terrain source, in order: --dtm-file tiles you supply -> EA LiDAR (England) -> Welsh Government LiDAR (Wales)
-> OS Terrain 50 everywhere else. Gaps in any of them are filled from Terrain 50. EA and Welsh LiDAR also give a
DSM, so building heights come from LiDAR; without a DSM they come from OSM tags, then the 6 m default.
Buildings: OSM, falling back to OS Open Map Local when OSM has none in the box.
"""
import argparse
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio

import json

from pipeline import bundle, buildings, cars, clean, dtm, heights, base, imagery, landcover, omlocal, terrain_fill, wales_lidar

NRW_ATTRIBUTION = "Contains Natural Resources Wales information © Natural Resources Wales and database right (OGL v3)"


def _valid_fraction(path):
    with rasterio.open(path) as ds:
        return float(1 - np.ma.getmaskarray(ds.read(1, masked=True)).mean())


def _log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def build_area(bbox, area_id, out_dir="data/bundles", dtm_files=None, dtm_attribution=NRW_ATTRIBUTION,
               buildings_source="auto", work_root="data/work", remove_cars=False):
    bbox = tuple(float(v) for v in bbox)
    w = Path(work_root) / str(area_id)
    w.mkdir(parents=True, exist_ok=True)
    credits, summary = [], {"id": str(area_id), "bbox": bbox}

    # 1. Terrain
    raw_dtm, dsm_path = w / "dtm_raw.tif", None
    if dtm_files:
        dtm.dtm_from_files(dtm_files, bbox, raw_dtm)
        dtm_source = "user-supplied tiles"
        credits.append(dtm_attribution)
    else:
        dtm.fetch_dtm(bbox, raw_dtm)
        if _valid_fraction(raw_dtm) > 0:
            dtm_source = "EA LiDAR"
            credits.append(dtm.ATTRIBUTION)
            dsm_path = w / "dsm.tif"
            dtm.fetch_dsm(bbox, dsm_path)
            if _valid_fraction(dsm_path) == 0:
                dsm_path = None
        elif wales_lidar.fetch_wales_lidar(bbox, raw_dtm, "dtm"):
            dtm_source = "Welsh Government LiDAR"
            credits.append(wales_lidar.ATTRIBUTION)
            dsm_path = w / "dsm.tif"
            if not wales_lidar.fetch_wales_lidar(bbox, dsm_path, "dsm") or _valid_fraction(dsm_path) == 0:
                dsm_path = None
        else:
            dtm_source = "OS Terrain 50 only"
    _log(f"DTM: {dtm_source} ({_valid_fraction(raw_dtm):.0%} of pixels from LiDAR)")
    filled = terrain_fill.fill_dtm(raw_dtm, w / "dtm.tif")
    if filled > 0:
        credits.append(terrain_fill.ATTRIBUTION)
    _log(f"Filled {filled:.1%} of the DTM from Terrain 50")
    summary.update(dtm_source=dtm_source, dtm_filled_pct=round(filled * 100, 1), has_dsm=dsm_path is not None)

    # 2. Buildings
    if buildings_source in ("auto", "osm"):
        b = gpd.read_file(buildings.fetch_buildings(bbox, w / "buildings_osm.geojson"))
        b_source = "OpenStreetMap"
    if buildings_source == "omlocal" or (buildings_source == "auto" and b.empty):
        b = omlocal.fetch_omlocal_buildings(bbox, w / "buildings_oml.geojson")
        b_source = "OS Open Map Local"
    credits.append(buildings.ATTRIBUTION if b_source == "OpenStreetMap" else omlocal.ATTRIBUTION)
    _log(f"Buildings: {len(b)} from {b_source}")
    if len(b):
        b = clean.clean_buildings(b)
        b = heights.assign_heights(b, w / "dtm.tif", dsm_path)
        b = base.assign_base(b, w / "dtm.tif")
    summary.update(buildings=len(b), buildings_source=b_source)
    if len(b):
        summary["height_sources"] = b.height_source.value_counts().to_dict()
    _log(f"Buildings after cleanup: {len(b)}")

    # 3. Imagery
    src = imagery.esri_world_imagery()
    img = imagery.fetch_imagery(bbox, w / "imagery.tif", source=src)
    credits.append(src.attribution)
    _log("Imagery fetched")
    if remove_cars:
        summary["cars_removed"] = cars.remove_cars(img, b)
        _log(f"Cars removed: {summary['cars_removed']}")

    # 4. Land cover (after the cars are gone, so the road under a parked car is seen as road)
    land = landcover.build_landcover(w / "dtm.tif", img, b, dsm_path, bbox=bbox)
    share = ", ".join(f"{k} {v:.0%}" for k, v in sorted(land[1]["share"].items(), key=lambda kv: -kv[1]))
    _log(f"Land cover: {share}" + ("" if land[1]["canopy_from_lidar"] else " (no LiDAR surface, so trees only where OSM maps them)"))
    summary["landcover"] = land[1]["share"]

    # 5. Bundle
    root = bundle.write_bundle(out_dir, area_id, w / "dtm.tif", img, b, credits, dsm_path, landcover=land)
    if remove_cars:   # say so in the bundle, so a reader can tell a cleaned build from a plain one
        meta = json.loads((root / "meta.json").read_text())
        meta["cars_removed"] = summary["cars_removed"]
        (root / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    summary["bundle"] = str(root)
    _log(f"Wrote {root}")
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--bbox", type=float, nargs=4, metavar=("MINE", "MINN", "MAXE", "MAXN"), help="EPSG:27700 metres")
    g.add_argument("--centre", type=float, nargs=2, metavar=("E", "N"), help="centre of a --size box, EPSG:27700")
    ap.add_argument("--size", type=float, default=1000, help="box edge in metres for --centre (default 1000, i.e. 4x the 500 m prototype area)")
    ap.add_argument("--id", required=True, help="area id; bundle goes to <out>/area_<id>/")
    ap.add_argument("--out", default="data/bundles")
    ap.add_argument("--dtm-file", nargs="+", help="GeoTIFF DTM tiles (EPSG:27700) to use instead of EA LiDAR, e.g. NRW tiles")
    ap.add_argument("--dtm-attribution", default=NRW_ATTRIBUTION, help="credit line for --dtm-file")
    ap.add_argument("--buildings", choices=["auto", "osm", "omlocal"], default="auto", dest="buildings_source")
    ap.add_argument("--remove-cars", action="store_true", help="paint parked cars out of the imagery (needs pipeline/requirements-cars.txt)")
    a = ap.parse_args(argv)
    if a.centre:
        e, n = a.centre
        h = a.size / 2
        bbox = (e - h, n - h, e + h, n + h)
    else:
        bbox = a.bbox
    if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        sys.exit("bbox must be MINE MINN MAXE MAXN with min < max")
    result = build_area(bbox, a.id, a.out, a.dtm_file, a.dtm_attribution, a.buildings_source, remove_cars=a.remove_cars)
    print(result)


if __name__ == "__main__":
    main()
