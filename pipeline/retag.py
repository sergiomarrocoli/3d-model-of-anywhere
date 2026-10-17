"""Add the OSM tags the client dresses walls with to bundles built before the pipeline carried them.

The tags come from the cached Overpass answer for the bundle's box (the same file the build used, read whatever its age), so no network is
needed. Buildings are matched by `osm_id`; a bundle whose cached answer is gone is left alone.

Usage: python3 -m pipeline.retag data/bundles/area_newtown [more bundles...]
"""
import argparse
import hashlib
import json
from pathlib import Path

from .buildings import CACHE_DIR, KEEP_TAGS, building_query
from .bundle import BUILDING_PROPS

TAGS = [k for k in KEEP_TAGS if k in BUILDING_PROPS and k not in ("building", "height")]


def cached_tags(bbox, cache_dir=CACHE_DIR):
    """{ 'way/123': {tag: value} } from the cached Overpass answer for `bbox`, or None if there is no cached answer."""
    path = Path(cache_dir) / (hashlib.sha1(building_query(bbox).encode()).hexdigest() + ".json")
    if not path.exists():
        return None
    return {f'{el["type"]}/{el["id"]}': el.get("tags", {}) for el in json.loads(path.read_text())["elements"]}


def retag_bundle(root, cache_dir=CACHE_DIR):
    """Merge the tags into the bundle's buildings.geojson in place. Returns { 'buildings', 'tagged' }, or None without a cached answer."""
    root = Path(root)
    meta = json.loads((root / "meta.json").read_text())
    tags = cached_tags(meta["bbox"], cache_dir)
    if tags is None:
        return None
    fc = json.loads((root / "buildings.geojson").read_text())
    tagged = 0
    for f in fc["features"]:
        got = tags.get(f["properties"].get("osm_id"), {})
        hit = False
        for k in TAGS:
            if got.get(k) is not None:
                f["properties"][k] = got[k]; hit = True
        tagged += hit
    (root / "buildings.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    return {"buildings": len(fc["features"]), "tagged": tagged}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bundle", nargs="+", help="bundle directories (data/bundles/area_<id>)")
    a = ap.parse_args()
    for b in a.bundle:
        print(b, retag_bundle(b) or "no cached Overpass answer for this box: left alone")
