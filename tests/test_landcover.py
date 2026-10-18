import geopandas as gpd
import numpy as np
import pytest
import rasterio
from pyproj import Transformer
from rasterio.transform import from_bounds
from shapely.geometry import box

from pipeline import landcover as lc

E0, N0, SIZE = 400000.0, 300000.0, 100.0          # a 100 m box, 200 x 200 cells at 0.5 m
TO_LONLAT = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True).transform


def way(points, **tags):
    """An Overpass way from local metres (x east, y north of the box's south-west corner)."""
    return {"type": "way", "id": 1, "tags": tags,
            "geometry": [{"lat": TO_LONLAT(E0 + x, N0 + y)[1], "lon": TO_LONLAT(E0 + x, N0 + y)[0]} for x, y in points]}


def square(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


def cell(arr, x, y):
    """The class at local metres (x, y); rows run north to south."""
    return int(arr[arr.shape[0] - 1 - int(y / lc.RES_M), int(x / lc.RES_M)])


def tif(path, value, count=1, dtype="float32"):
    with rasterio.open(path, "w", driver="GTiff", width=200, height=200, count=count, dtype=dtype, crs="EPSG:27700",
                       transform=from_bounds(E0, N0, E0 + SIZE, N0 + SIZE, 200, 200)) as dst:
        data = np.broadcast_to(np.asarray(value, dtype=dtype).reshape(count, 200, 200) if np.ndim(value) else np.full((count, 200, 200), value, dtype=dtype), (count, 200, 200))
        dst.write(data)
    return path


class TestTags:
    def test_areas(self):
        assert lc.area_class({"natural": "water"}) == lc.WATER
        assert lc.area_class({"natural": "wood"}) == lc.TREE
        assert lc.area_class({"landuse": "grass"}) == lc.GRASS
        assert lc.area_class({"leisure": "park"}) == lc.GRASS
        assert lc.area_class({"amenity": "parking"}) == lc.PAVED
        assert lc.area_class({"amenity": "parking", "surface": "gravel"}) == lc.BARE
        assert lc.area_class({"leisure": "pitch", "surface": "asphalt"}) == lc.PAVED
        assert lc.area_class({"natural": "beach"}) == lc.BARE
        assert lc.area_class({"building": "yes"}) is None
        assert lc.area_class({"landuse": "residential"}) is None

    def test_lines(self):
        assert lc.line_class({"highway": "residential"}) == (lc.ROAD, 6, False)
        assert lc.line_class({"highway": "footway"}) == (lc.PAVED, 2, False)
        assert lc.line_class({"highway": "track"})[0] == lc.BARE
        assert lc.line_class({"highway": "path", "surface": "dirt"})[0] == lc.BARE
        assert lc.line_class({"highway": "residential", "surface": "gravel"})[0] == lc.BARE
        assert lc.line_class({"waterway": "stream"}) == (lc.WATER, 2.5, False)
        assert lc.line_class({"railway": "rail"})[0] == lc.BARE
        assert lc.line_class({"highway": "primary", "bridge": "yes"})[2] is True

    def test_tunnels_and_areas_are_not_lines(self):
        assert lc.line_class({"highway": "primary", "tunnel": "yes"}) is None
        assert lc.line_class({"waterway": "river", "tunnel": "culvert"}) is None
        assert lc.line_class({"highway": "primary", "layer": "-1"}) is None
        assert lc.line_class({"highway": "pedestrian", "area": "yes"}) is None

    def test_width_comes_from_the_tag_then_lanes_then_the_type(self):
        assert lc.line_class({"highway": "residential", "width": "9.5 m"})[1] == 9.5
        assert lc.line_class({"highway": "residential", "lanes": "4"})[1] == 12.0
        assert lc.line_class({"highway": "residential", "width": "wide"})[1] == 6


def build(tmp_path, elements, buildings=(), canopy=None, imagery=(110, 125, 112)):
    dtm = tif(tmp_path / "dtm.tif", 10.0)
    dsm = tif(tmp_path / "dsm.tif", 10.0 if canopy is None else canopy + 10.0) if canopy is not False else None
    img = tif(tmp_path / "img.tif", np.broadcast_to(np.array(imagery, "uint8")[:, None, None], (3, 200, 200)).copy(), count=3, dtype="uint8")
    homes = gpd.GeoDataFrame({"building": ["yes"] * len(buildings)}, geometry=[box(E0 + a, N0 + b, E0 + c, N0 + d) for a, b, c, d in buildings], crs="EPSG:27700")
    return lc.build_landcover(dtm, img, homes, dsm, elements=elements)


def test_layers_are_painted_in_priority_order(tmp_path):
    elements = [
        way(square(5, 5, 45, 45), leisure="park"),                                    # a park, lower left
        way([(0, 80), (100, 80)], highway="residential"),                              # a road across the top
        way([(50, 0), (50, 100)], waterway="river"),                                   # a river up the middle
        way([(40, 80), (60, 80)], highway="residential", bridge="yes"),                # the road carried over the river
    ]
    arr, info = build(tmp_path, elements, buildings=[(70, 10, 90, 30)])
    assert cell(arr, 25, 25) == lc.GRASS
    assert cell(arr, 20, 80) == lc.ROAD
    assert cell(arr, 50, 20) == lc.WATER
    assert cell(arr, 50, 80) == lc.ROAD                                               # the bridge beats the river
    assert cell(arr, 80, 20) == lc.BUILDING
    assert info["osm_elements"] == 4


def test_canopy_height_makes_trees_but_not_on_buildings_or_under_roads(tmp_path):
    canopy = np.zeros((200, 200), "float32")
    canopy[20:100, 20:100] = 8.0                     # rows 20..100 from the top = y 50..90 m north-south band, x 10..50 m
    arr, info = build(tmp_path, [way([(0, 70), (100, 70)], highway="residential")], buildings=[(10, 80, 30, 90)], canopy=canopy)
    assert info["canopy_from_lidar"] is True
    assert cell(arr, 40, 85) == lc.TREE
    assert cell(arr, 20, 85) == lc.BUILDING          # tall, but it is a roof
    assert cell(arr, 30, 70) == lc.ROAD              # the canopy overhangs the road: the ground is still road


def test_no_lidar_means_no_canopy_trees_but_mapped_woods_still_count(tmp_path):
    arr, info = build(tmp_path, [way(square(10, 10, 40, 40), natural="wood")], canopy=False)
    assert info["canopy_from_lidar"] is False
    assert cell(arr, 25, 25) == lc.TREE


def test_unmapped_ground_is_guessed_from_colour(tmp_path):
    green, _ = build(tmp_path, [], imagery=(50, 110, 45))
    grey, _ = build(tmp_path, [], imagery=(120, 122, 118))
    tan, _ = build(tmp_path, [], imagery=(190, 160, 110))
    assert cell(green, 50, 50) == lc.GRASS and cell(grey, 50, 50) == lc.PAVED and cell(tan, 50, 50) == lc.BARE


def test_the_raster_is_half_metre_cells_and_the_share_adds_up(tmp_path):
    arr, info = build(tmp_path, [way(square(0, 0, 100, 100), landuse="grass")])
    assert arr.shape == (200, 200) and arr.dtype == np.uint8 and info["resolution_m"] == 0.5
    assert sum(info["share"].values()) == pytest.approx(1.0, abs=0.001)
