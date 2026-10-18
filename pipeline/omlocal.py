"""Building footprints from OS Open Map Local, the fallback when OSM has none in the box (PLAN §1).

OS publishes it keylessly as one shapefile zip per 100 km grid square (40-120 MB), which is
downloaded once into `data/cache/omlocal/`.

Usage: python3 -m pipeline.omlocal --bbox 258500 347700 259000 348200 --out data/buildings_oml.geojson
"""
import argparse
from pathlib import Path

import geopandas as gpd
import requests
from shapely.geometry import box

from pipeline.progress import download
from pipeline.terrain_fill import tile_name

CACHE = Path("data/cache/omlocal")
ATTRIBUTION = "Contains OS data © Crown copyright and database right (OGL v3)"
URL = "https://api.os.uk/downloads/v1/products/OpenMapLocal/downloads?area={sq}&format=ESRI%C2%AE+Shapefile&redirect"
CRS = "EPSG:27700"


def squares_for_bbox(bbox):
    min_e, min_n, max_e, max_n = bbox
    corners = [(min_e, min_n), (min_e, max_n), (max_e, min_n), (max_e, max_n)]
    return sorted({tile_name(e, n)[:2].upper() for e, n in corners})


def ensure_zip(square, cache=CACHE):
    return download(URL.format(sq=square), Path(cache) / f"opmplc_essh_{square.lower()}.zip", f"OS Open Map Local, grid square {square}")


def fetch_omlocal_buildings(bbox, out=None, cache=CACHE):
    """Buildings clipped to `bbox` (EPSG:27700). Returns a GeoDataFrame, and writes GeoJSON if `out` is given."""
    parts = []
    for sq in squares_for_bbox(bbox):
        zpath = ensure_zip(sq, cache)
        gdf = gpd.read_file(f"zip://{zpath}!OS OpenMap Local (ESRI Shape File) {sq}/data/{sq}_Building.shp", bbox=tuple(bbox))
        parts.append(gdf)
    gdf = gpd.GeoDataFrame(gpd.pd.concat(parts, ignore_index=True), crs=CRS) if parts else gpd.GeoDataFrame(geometry=[], crs=CRS)
    if len(gdf):
        gdf = gdf[["geometry"]].copy()
        gdf["geometry"] = gdf.geometry.make_valid().intersection(box(*bbox))
        gdf = gdf[~gdf.geometry.is_empty].explode(index_parts=False)
        gdf = gdf[gdf.geom_type == "Polygon"].reset_index(drop=True)
    gdf["building"] = "yes"
    gdf["osm_id"] = [f"oml/{i}" for i in range(len(gdf))]
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        gdf.to_file(out, driver="GeoJSON")
    return gdf


def fetch_omlocal_roads(bbox, cache=CACHE):
    """Road centrelines clipped to `bbox` (EPSG:27700), used to find where the aerial photo sits on the grid."""
    parts = [gpd.read_file(f"zip://{ensure_zip(sq, cache)}!OS OpenMap Local (ESRI Shape File) {sq}/data/{sq}_Road.shp", bbox=tuple(bbox)) for sq in squares_for_bbox(bbox)]
    gdf = gpd.GeoDataFrame(gpd.pd.concat(parts, ignore_index=True), crs=CRS) if parts else gpd.GeoDataFrame(geometry=[], crs=CRS)
    return gdf[["geometry"]].copy() if len(gdf) else gdf


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("MINE", "MINN", "MAXE", "MAXN"))
    ap.add_argument("--out", default="data/buildings_oml.geojson")
    a = ap.parse_args()
    g = fetch_omlocal_buildings(a.bbox, a.out)
    print({"count": len(g), "crs": str(g.crs), "area_m2": round(float(g.area.sum()))})
