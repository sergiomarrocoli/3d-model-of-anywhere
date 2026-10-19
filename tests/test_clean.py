import geopandas as gpd
from shapely.geometry import Polygon

from pipeline.clean import clean_buildings


def _gdf(polys):
    return gpd.GeoDataFrame({"id": range(len(polys))}, geometry=polys, crs="EPSG:27700")


def test_drops_slivers_and_small_polygons():
    g = _gdf([
        Polygon([(20, 0), (40, 0), (40, 0.1), (20, 0.1)]),  # 2 m² sliver
        Polygon([(50, 0), (52, 0), (52, 2), (50, 2)]),      # 4 m²
        Polygon([(60, 0), (70, 0), (70, 10), (60, 10)]),    # 100 m²
    ])
    assert list(clean_buildings(g).id) == [2]


def test_repairs_invalid_bowtie():
    g = _gdf([Polygon([(0, 0), (10, 10), (10, 0), (0, 10)])])
    out = clean_buildings(g)
    assert len(out) == 2 and out.geometry.is_valid.all()


def test_keeps_attributes_and_crs():
    g = _gdf([Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])])
    out = clean_buildings(g)
    assert list(out.columns) == ["id", "geometry"] and out.crs == g.crs


def test_footprints_come_out_flat_whatever_they_went_in_as():
    # Open Map Local's polygons carry a Z; anything that reads outline points as (x, y) pairs (the car detector's building mask) fails on a third value
    from shapely.geometry import Polygon
    z = Polygon([(0, 0, 5), (10, 0, 5), (10, 10, 5), (0, 10, 5)])
    out = clean_buildings(gpd.GeoDataFrame({"building": ["yes"]}, geometry=[z], crs="EPSG:27700"))
    assert len(out) == 1 and not out.geometry.iloc[0].has_z and out.crs == "EPSG:27700"
    assert all(len(p) == 2 for p in out.geometry.iloc[0].exterior.coords) and abs(out.geometry.iloc[0].area - 100) < 1e-6
