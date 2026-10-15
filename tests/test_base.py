import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from pipeline.base import assign_base


@pytest.fixture
def sloped_dtm(tmp_path):
    """10x10 m grid at 1 m, elevation = 100 + x (a slope rising to the east)."""
    arr = np.tile(100 + np.arange(10, dtype="float32") + 0.5, (10, 1))
    p = tmp_path / "dtm.tif"
    with rasterio.open(p, "w", driver="GTiff", width=10, height=10, count=1, dtype="float32",
                       crs="EPSG:27700", transform=from_origin(0, 10, 1, 1)) as ds:
        ds.write(arr, 1)
    return str(p)


def test_base_is_minimum_under_footprint(sloped_dtm):
    g = gpd.GeoDataFrame(geometry=[box(2, 2, 6, 6)], crs="EPSG:27700")
    assert assign_base(g, sloped_dtm).base_z[0] == pytest.approx(102.5)  # lowest pixel is x=2 -> 102.5


def test_tiny_footprint_uses_touched_pixel(sloped_dtm):
    g = gpd.GeoDataFrame(geometry=[box(3.1, 3.1, 3.3, 3.3)], crs="EPSG:27700")
    assert assign_base(g, sloped_dtm).base_z[0] == pytest.approx(103.5)
