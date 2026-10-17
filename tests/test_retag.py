import hashlib
import json

from pipeline.buildings import KEEP_TAGS, building_query
from pipeline.bundle import BUILDING_PROPS
from pipeline.retag import TAGS, cached_tags, retag_bundle

BBOX = [310450.0, 290880.0, 310950.0, 291380.0]


def _cache(tmp_path, elements):
    d = tmp_path / "overpass"; d.mkdir()
    (d / (hashlib.sha1(building_query(BBOX).encode()).hexdigest() + ".json")).write_text(json.dumps({"elements": elements}))
    return d


def _bundle(tmp_path, ids):
    root = tmp_path / "area_x"; root.mkdir()
    (root / "meta.json").write_text(json.dumps({"bbox": BBOX}))
    feats = [{"type": "Feature", "properties": {"osm_id": i, "height": 7.0}, "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [5, 0], [5, 5], [0, 0]]]}} for i in ids]
    (root / "buildings.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    return root


def test_the_wall_tags_are_fetched_and_go_into_the_bundle():
    wall = {"building:levels", "building:material", "building:colour", "shop", "amenity"}
    assert wall <= set(KEEP_TAGS) and wall <= set(BUILDING_PROPS)
    assert set(TAGS) == wall                                       # retag adds exactly those


def test_the_query_is_the_cache_key_and_depends_only_on_the_box():
    assert building_query(BBOX) == building_query(list(BBOX)) and building_query(BBOX) != building_query([0, 0, 10, 10])


def test_tags_are_merged_by_osm_id_and_nothing_else_is_touched(tmp_path):
    cache = _cache(tmp_path, [
        {"type": "way", "id": 1, "tags": {"building": "yes", "building:material": "brick", "shop": "bakery", "name": "Greggs", "height": "99"}},
        {"type": "relation", "id": 2, "tags": {"building": "church"}},
    ])
    root = _bundle(tmp_path, ["way/1", "relation/2", "way/3"])
    assert retag_bundle(root, cache) == {"buildings": 3, "tagged": 1}
    props = {f["properties"]["osm_id"]: f["properties"] for f in json.loads((root / "buildings.geojson").read_text())["features"]}
    assert props["way/1"]["building:material"] == "brick" and props["way/1"]["shop"] == "bakery"
    assert "name" not in props["way/1"] and props["way/1"]["height"] == 7.0         # untagged things and the computed height are left alone
    assert "building:material" not in props["relation/2"] and "building:material" not in props["way/3"]


def test_a_bundle_with_no_cached_answer_is_left_alone(tmp_path):
    root = _bundle(tmp_path, ["way/1"]); before = (root / "buildings.geojson").read_text()
    assert cached_tags(BBOX, tmp_path / "nothing") is None and retag_bundle(root, tmp_path / "nothing") is None
    assert (root / "buildings.geojson").read_text() == before
