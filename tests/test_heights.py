import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from pipeline.heights import assign_heights, osm_height, parse_osm_height


@pytest.fixture
def rasters(tmp_path):
    """20x20 m grid at 1 m: flat ground at 10 m; DSM has a 10 m-tall block at x 2-8, y 2-8 and a 1 m bump at x 12-14."""
    transform = from_origin(0, 20, 1, 1)
    dtm = np.full((20, 20), 10.0, dtype="float32")
    dsm = dtm.copy()
    dsm[12:18, 2:8] += 10.0   # rows count down from y=20, so rows 12-17 -> y 2-8
    dsm[12:18, 12:14] += 1.0
    paths = []
    for name, arr in (("dtm", dtm), ("dsm", dsm)):
        p = tmp_path / f"{name}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=20, height=20, count=1, dtype="float32",
                           crs="EPSG:27700", transform=transform) as ds:
            ds.write(arr, 1)
        paths.append(str(p))
    return paths


def _gdf(geoms, **cols):
    return gpd.GeoDataFrame({"height": [None] * len(geoms), "building:levels": [None] * len(geoms), **cols},
                            geometry=geoms, crs="EPSG:27700")


def test_parse_osm_height():
    assert parse_osm_height("12") == 12 and parse_osm_height("12.5 m") == 12.5 and parse_osm_height("12m") == 12
    assert parse_osm_height("40 ft") is None and parse_osm_height("5-7") is None and parse_osm_height(None) is None


def test_osm_height_prefers_height_then_levels():
    assert osm_height("9", "4") == 9
    assert osm_height(None, "4") == 12
    assert osm_height("junk", "2") == 6
    assert osm_height(None, None) is None


def test_lidar_first(rasters):
    out = assign_heights(_gdf([box(2, 2, 8, 8)], **{}), *rasters)
    assert out.height_source[0] == "lidar" and out.height[0] == pytest.approx(10.0)


def test_falls_back_to_osm_then_default(rasters):
    # bump is only 1 m (< MIN_LIDAR_HEIGHT_M) so lidar is rejected; ground-only footprint likewise
    g = _gdf([box(12, 2, 14, 8), box(15, 2, 19, 8)])
    g.loc[0, "building:levels"] = "3"
    out = assign_heights(g, *rasters)
    assert list(out.height_source) == ["osm", "default"]
    assert list(out.height) == [9.0, 6.0]
