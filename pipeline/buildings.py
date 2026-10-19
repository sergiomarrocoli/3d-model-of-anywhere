"""Fetch OSM building footprints for a bbox in EPSG:27700, clipped to the box.

Usage: python3 -m pipeline.buildings --bbox 375000 164500 375500 165000 --out data/buildings.geojson
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path

import geopandas as gpd
import requests
from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.ops import polygonize, transform, unary_union

from pipeline.progress import say

# Tried in order. The main instance can fail TLS on LibreSSL-based Pythons (e.g. macOS system Python).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"
CRS = "EPSG:27700"
CACHE_DIR = Path("data/cache/overpass")
CACHE_TTL_S = 7 * 24 * 3600  # building footprints change slowly; this keeps repeat builds off the public servers
# `building:levels` and the tags after it are not used by the pipeline itself: they go into the bundle for the client to dress the walls with
KEEP_TAGS = ("building", "height", "building:levels", "building:material", "building:colour", "shop", "amenity")


def _to_wgs84_bbox(bbox):
    t = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    min_e, min_n, max_e, max_n = bbox
    lons, lats = zip(*(t.transform(e, n) for e in (min_e, max_e) for n in (min_n, max_n)))
    return min(lats), min(lons), max(lats), max(lons)


def _polygons_from_lines(lines):
    """Rings from member ways. An outline is often split over several ways that are only closed all together, so node
    them where they meet and take the closed rings (a way that is already closed passes straight through)."""
    lines = [l for l in lines if len(l.coords) >= 2]
    if not lines:
        return []
    return list(polygonize(unary_union(lines)))   # union nodes the lines where they meet, then polygonize finds the closed rings


def _rings(el):
    """Polygons for an Overpass way, or a multipolygon relation (queried with `out geom`, which includes member geometry)."""
    if el["type"] == "way":
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        return [Polygon(pts)] if len(pts) >= 4 and pts[0] == pts[-1] else []
    outers, inners = [], []
    for m in el.get("members", []):
        pts = [(p["lon"], p["lat"]) for p in m.get("geometry", [])]
        if len(pts) >= 2:
            (inners if m.get("role") == "inner" else outers).append(LineString(pts))
    shells = _polygons_from_lines(outers)
    if not shells:
        return []
    shell = unary_union(shells)
    holes = _polygons_from_lines(inners)
    return [shell.difference(unary_union(holes)) if holes else shell]


class _Cached:
    """Stands in for a requests response when the answer came from the disk cache (or from curl)."""

    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass

    def json(self):
        return json.loads(self.text)


USER_AGENT = "uk-map-3d (github.com/sergiomarrocoli/uk-map-3d)"
RATE_LIMIT_WAIT_S = 20     # a 429 from a server: wait this long and ask the same one again once, before trying a mirror
CURL_TIMEOUT_S = 150       # overpass-api.de can take over 30 s to answer even a trivial query when it is busy


def _curl_post(url, query, timeout=CURL_TIMEOUT_S):
    """The same POST through curl, which has its own TLS: macOS's system Python (LibreSSL 2.8) cannot make a connection to overpass-api.de,
    which would leave only the mirrors (often down), but curl can. Returns a response-like object; raises RequestException if curl is missing or fails."""
    curl = shutil.which("curl")
    if curl is None:
        raise requests.RequestException("curl is not installed")
    done = subprocess.run([curl, "-sS", "--fail", "-m", str(timeout), "-A", USER_AGENT, "--data-urlencode", "data@-", url],
                          input=query, capture_output=True, text=True)
    if done.returncode != 0:
        raise requests.RequestException(f"curl exit {done.returncode}: {done.stderr.strip()[:160]}")
    return _Cached(done.stdout)


def _rate_limited(exc):
    """Did the server say 'too many requests' (HTTP 429), as a requests error or through curl's message?"""
    text = str(exc)
    return "429" in text or "Too Many Requests" in text


def _overpass(query, cache_dir=None, ttl=None, what="OpenStreetMap data"):
    """POST an Overpass query, with a disk cache keyed by the query text so the same area is asked for once a week."""
    cache_dir = Path(CACHE_DIR if cache_dir is None else cache_dir)
    ttl = CACHE_TTL_S if ttl is None else ttl
    cached = cache_dir / (hashlib.sha1(query.encode()).hexdigest() + ".json")
    if cached.exists() and time.time() - cached.stat().st_mtime < ttl:
        say(f"Using the saved copy of the {what}")
        return _Cached(cached.read_text())

    errors = []
    for attempt in range(3):
        for url in OVERPASS_URLS:
            host = url.split("/")[2]
            for go in range(2):                          # a second go at the same server, only after a rate limit
                say(f"Asking {host} for the {what}" + (f" (attempt {attempt + 1})" if attempt else "") + (" again" if go else ""))
                try:
                    try:
                        resp = requests.post(url, data={"data": query}, timeout=90, headers={"User-Agent": USER_AGENT})
                    except requests.exceptions.SSLError:
                        say(f"Python cannot make the TLS connection to {host}; asking through curl instead (this can take a minute)")
                        resp = _curl_post(url, query)
                    resp.raise_for_status()
                    resp.json()
                    cache_dir.mkdir(parents=True, exist_ok=True)
                    tmp = cached.with_suffix(".tmp")
                    tmp.write_text(resp.text)
                    tmp.replace(cached)  # atomic, so a half-written file is never read
                    return resp
                except (requests.RequestException, ValueError) as exc:
                    reason = f"{type(exc).__name__}: {' '.join(str(exc).split())[:150]}".rstrip(": ")
                    errors.append(f"{url}: {reason}")
                    if go == 0 and _rate_limited(exc):
                        say(f"{host} is rate limiting us ({reason}); waiting {RATE_LIMIT_WAIT_S} s, then asking it again")
                        time.sleep(RATE_LIMIT_WAIT_S)
                        continue
                    say(f"{host} did not answer ({reason}); trying the next one")
                    break
        time.sleep(5 * (attempt + 1))  # public instances are often overloaded; back off and retry
    raise RuntimeError("All Overpass endpoints failed: " + "; ".join(errors))


def building_query(bbox):
    """The Overpass query for the buildings in a bbox (EPSG:27700). Its text is the disk cache's key."""
    s, w, n, e = _to_wgs84_bbox(bbox)
    # `out geom;` (tags, and member geometry for relations). Adding `tags` here would strip the members from every
    # multipolygon relation, silently dropping courtyard and other large buildings.
    return f'[out:json][timeout:60];(way["building"]({s},{w},{n},{e});relation["building"]({s},{w},{n},{e}););out geom;'


def fetch_buildings(bbox, out):
    """bbox = (minE, minN, maxE, maxN) in EPSG:27700. Writes GeoJSON (27700 metres) to `out`."""
    resp = _overpass(building_query(bbox), what="buildings")

    to_bng = Transformer.from_crs("EPSG:4326", CRS, always_xy=True).transform
    rows = []
    for el in resp.json()["elements"]:
        for geom in _rings(el):
            if geom.is_empty:
                continue
            props = {k: el.get("tags", {}).get(k) for k in KEEP_TAGS}
            props["osm_id"] = f'{el["type"]}/{el["id"]}'
            rows.append({**props, "geometry": transform(to_bng, geom)})

    if not rows:  # nothing mapped here (open country, a rural box): an empty result, not an error
        gdf = gpd.GeoDataFrame({"osm_id": []}, geometry=[], crs=CRS)
    else:
        gdf = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS)
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
