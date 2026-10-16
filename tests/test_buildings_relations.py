import pytest
from shapely.geometry import Polygon

from pipeline import buildings


def pts(*coords):
    return [{"lon": x, "lat": y} for x, y in coords]


def member(role, *coords):
    return {"type": "way", "role": role, "geometry": pts(*coords)}


SQ = [(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]
HOLE = [(4, 4), (6, 4), (6, 6), (4, 6), (4, 4)]


def rel(*members):
    return {"type": "relation", "id": 1, "tags": {"building": "yes"}, "members": list(members)}


def area(polys):
    return sum(p.area for p in polys)


def test_outer_with_a_courtyard_hole():
    (p,) = buildings._rings(rel(member("outer", *SQ), member("inner", *HOLE)))
    assert p.area == pytest.approx(100 - 4) and len(p.interiors) == 1


def test_outer_ring_split_across_several_ways():
    # the same square, as three open ways that only close together (how large buildings are usually mapped)
    r = rel(member("outer", (0, 0), (10, 0), (10, 5)), member("outer", (10, 5), (10, 10), (0, 10)), member("outer", (0, 10), (0, 0)),
            member("inner", *HOLE))
    (p,) = buildings._rings(r)
    assert p.area == pytest.approx(96)


def test_ways_given_in_any_order_and_direction():
    r = rel(member("outer", (0, 10), (0, 0)), member("outer", (10, 10), (10, 5), (10, 0)), member("outer", (0, 10), (10, 10)), member("outer", (0, 0), (10, 0)))
    assert area(buildings._rings(r)) == pytest.approx(100)


def test_inner_ring_split_across_ways():
    r = rel(member("outer", *SQ), member("inner", (4, 4), (6, 4), (6, 6)), member("inner", (6, 6), (4, 6), (4, 4)))
    (p,) = buildings._rings(r)
    assert p.area == pytest.approx(96)


def test_two_separate_outer_parts_stay_one_building():
    far = [(20, 0), (30, 0), (30, 10), (20, 10), (20, 0)]
    assert area(buildings._rings(rel(member("outer", *SQ), member("outer", *far)))) == pytest.approx(200)


def test_unusable_relations_give_nothing_instead_of_failing():
    assert buildings._rings({"type": "relation", "id": 1, "tags": {}}) == []                            # members stripped
    assert buildings._rings(rel()) == []
    assert buildings._rings(rel(member("outer", (0, 0), (10, 0), (10, 10)))) == []                       # never closes
    assert buildings._rings(rel(member("inner", *HOLE))) == []                                          # holes with no outline
    assert buildings._rings(rel(member("outer", (1, 1)))) == []


def test_ways_still_work():
    assert area(buildings._rings({"type": "way", "geometry": pts(*SQ)})) == pytest.approx(100)
    assert buildings._rings({"type": "way", "geometry": pts((0, 0), (1, 0), (1, 1))}) == []


def test_query_asks_for_member_geometry(tmp_path, monkeypatch):
    seen = {}

    class R:
        def json(self): return {"elements": []}

    monkeypatch.setattr(buildings, "_overpass", lambda q, **kw: seen.update(q=q) or R())
    buildings.fetch_buildings((310450, 290880, 310950, 291380), tmp_path / "b.geojson")
    assert seen["q"].rstrip().endswith("out geom;")        # not `out geom tags;`, which strips relation members
    assert 'relation["building"]' in seen["q"]


def test_a_relation_building_ends_up_in_the_output(tmp_path, monkeypatch):
    # around Newtown, so the lon/lat -> grid conversion is realistic
    x0, y0 = -3.3160, 52.5130
    ring = [(x0, y0), (x0 + 0.0004, y0), (x0 + 0.0004, y0 + 0.0003), (x0, y0 + 0.0003), (x0, y0)]
    hole = [(x0 + 0.0001, y0 + 0.0001), (x0 + 0.0002, y0 + 0.0001), (x0 + 0.0002, y0 + 0.0002), (x0 + 0.0001, y0 + 0.0002), (x0 + 0.0001, y0 + 0.0001)]
    el = rel(member("outer", *ring), member("inner", *hole))

    class R:
        def json(self): return {"elements": [el]}

    monkeypatch.setattr(buildings, "_overpass", lambda q, **kw: R())
    import geopandas as gpd
    out = buildings.fetch_buildings((310450, 290880, 311450, 291880), tmp_path / "b.geojson")
    g = gpd.read_file(out)
    assert len(g) == 1 and g.iloc[0].geometry.geom_type == "Polygon" and len(g.iloc[0].geometry.interiors) == 1
    assert g.iloc[0]["osm_id"] == "relation/1" and g.crs.to_string() == "EPSG:27700"


def test_a_box_with_no_buildings_gives_an_empty_file_not_an_error(tmp_path, monkeypatch):
    class R:
        def json(self): return {"elements": []}

    monkeypatch.setattr(buildings, "_overpass", lambda q, **kw: R())
    import geopandas as gpd
    out = buildings.fetch_buildings((310450, 290880, 311450, 291880), tmp_path / "b.geojson")
    assert len(gpd.read_file(out)) == 0
