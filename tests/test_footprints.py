import geopandas as gpd
from shapely.geometry import box

from pipeline import footprints

CRS = "EPSG:27700"
gdf = lambda ids, geoms, **cols: gpd.GeoDataFrame({"osm_id": ids, **cols}, geometry=geoms, crs=CRS)


def test_adds_only_buildings_osm_does_not_have():
    osm = gdf(["way/1"], [box(0, 0, 10, 10)])
    oml = gdf(["oml/0", "oml/1", "oml/2"], [box(1, 1, 9, 9), box(20, 20, 30, 30), box(8, 0, 18, 10)])      # inside OSM's, free-standing, 80% outside
    out = footprints.add_missing(osm, oml)
    assert list(out.osm_id) == ["way/1", "oml/1", "oml/2"]


def test_nothing_to_add_leaves_osm_untouched():
    osm = gdf(["way/1"], [box(0, 0, 10, 10)])
    assert footprints.add_missing(osm, gdf([], [])) is osm
    assert list(footprints.add_missing(gdf([], []), gdf(["oml/0"], [box(0, 0, 5, 5)])).osm_id) == ["oml/0"]


def test_drops_open_map_local_additions_the_lidar_does_not_confirm():
    b = gdf(["way/1", "way/2", "oml/0", "oml/1"], [box(i, 0, i + 1, 1) for i in range(4)], height_source=["osm", "lidar", "lidar", "default"])
    assert list(footprints.drop_unconfirmed(b).osm_id) == ["way/1", "way/2", "oml/0"]      # OSM's own buildings stay whatever their height source
