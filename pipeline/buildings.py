"""Fetch OSM building footprints for a bbox in EPSG:27700, clipped to the box.

Usage: python3 -m pipeline.buildings --bbox 375000 164500 375500 165000 --out data/buildings.geojson
"""
import argparse
import time
from pathlib import Path

import geopandas as gpd
import requests
from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.ops import transform, unary_union

# Tried in order. The main instance can fail TLS on LibreSSL-based Pythons (e.g. macOS system Python).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"
CRS = "EPSG:27700"
KEEP_TAGS = ("building", "height", "building:levels")


def _to_wgs84_bbox(bbox):
    t = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    min_e, min_n, max_e, max_n = bbox
    lons, lats = zip(*(t.transform(e, n) for e in (min_e, max_e) for n in (min_n, max_n)))
    return min(lats), min(lons), max(lats), max(lons)


def _rings(el, nodes_by_id=None):
    """Return polygons for an Overpass way or multipolygon relation (with `out geom`)."""
    if el["type"] == "way":
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        return [Polygon(pts)] if len(pts) >= 4 and pts[0] == pts[-1] else []
    outers, inners = [], []
    for m in el.get("members", []):
        pts = [(p["lon"], p["lat"]) for p in m.get("geometry", [])]
        if len(pts) >= 4 and pts[0] == pts[-1]:
            (inners if m["role"] == "inner" else outers).append(Polygon(pts))
    if not outers:
        return []
    shell = unary_union(outers)
    return [shell.difference(unary_union(inners)) if inners else shell]


def _overpass(query):
    errors = []
    for attempt in range(3):
        for url in OVERPASS_URLS:
            try:
                resp = requests.post(url, data={"data": query}, timeout=90,
                                     headers={"User-Agent": "civil-war-prototype (github.com/sergiomarrocoli/civil-war)"})
                resp.raise_for_status()
                resp.json()
                return resp
            except (requests.RequestException, ValueError) as exc:
                errors.append(f"{url}: {type(exc).__name__}")
        time.sleep(5 * (attempt + 1))  # public instances are often overloaded; back off and retry
    raise RuntimeError("All Overpass endpoints failed: " + "; ".join(errors))


def fetch_buildings(bbox, out):
    """bbox = (minE, minN, maxE, maxN) in EPSG:27700. Writes GeoJSON (27700 metres) to `out`."""
    s, w, n, e = _to_wgs84_bbox(bbox)
    q = f'[out:json][timeout:60];(way["building"]({s},{w},{n},{e});relation["building"]({s},{w},{n},{e}););out geom tags;'
    resp = _overpass(q)

    to_bng = Transformer.from_crs("EPSG:4326", CRS, always_xy=True).transform
    rows = []
    for el in resp.json()["elements"]:
        for geom in _rings(el):
            if geom.is_empty:
                continue
            props = {k: el.get("tags", {}).get(k) for k in KEEP_TAGS}
            props["osm_id"] = f'{el["type"]}/{el["id"]}'
            rows.append({**props, "geometry": transform(to_bng, geom)})

    gdf = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS)
    if gdf.empty:
        gdf = gpd.GeoDataFrame({"osm_id": []}, geometry=[], crs=CRS)
    else:
        gdf["geometry"] = gdf.geometry.make_valid().intersection(box(*bbox))
        gdf = gdf[~gdf.geometry.is_empty].explode(index_parts=False)
        gdf = gdf[gdf.geom_type == "Polygon"].reset_index(drop=True)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    return out


def summarise(path):
    g = gpd.read_file(path)
    return {"crs": str(g.crs), "count": len(g),
            "bounds": tuple(float(b) for b in g.total_bounds) if len(g) else None,
            "with_height_or_levels": int((g["height"].notna() | g["building:levels"].notna()).sum()) if len(g) else 0}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("MINE", "MINN", "MAXE", "MAXN"))
    ap.add_argument("--out", default="data/buildings.geojson")
    args = ap.parse_args()
    print(summarise(fetch_buildings(args.bbox, args.out)))
