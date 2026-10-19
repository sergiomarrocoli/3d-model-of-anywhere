import numpy as np
import pytest
import rasterio
import geopandas as gpd
from rasterio.transform import from_bounds
from shapely.geometry import box

from pipeline import cars


def _tif(path, size=64, metres=16):
    rgb = np.full((3, size, size), 100, np.uint8)
    with rasterio.open(path, "w", driver="GTiff", width=size, height=size, count=3, dtype="uint8", crs="EPSG:27700",
                       transform=from_bounds(1000, 2000, 1000 + metres, 2000 + metres, size, size), compress="deflate") as dst:
        dst.write(rgb)
    return path


def test_the_cleaned_picture_replaces_the_tiff_and_keeps_its_georeferencing(tmp_path, monkeypatch):
    path = _tif(tmp_path / "imagery.tif")
    seen = {}

    def fake(rgb, features, px_per_m):
        seen.update(shape=rgb.shape, features=features, px_per_m=px_per_m)
        out = rgb.copy(); out[10:20, 10:20] = (7, 8, 9)
        return out, 3

    monkeypatch.setattr(cars, "_remove", fake)
    homes = gpd.GeoDataFrame({"building": ["yes"]}, geometry=[box(1004, 2004, 1008, 2008)], crs="EPSG:27700")
    assert cars.remove_cars(path, homes) == 3
    assert seen["shape"] == (64, 64, 3) and seen["px_per_m"] == 4.0
    assert {tuple(c) for c in seen["features"][0]["geometry"]["coordinates"][0]} == {(4.0, 4.0), (8.0, 4.0), (8.0, 8.0), (4.0, 8.0)}   # local metres from the south-west corner
    with rasterio.open(path) as ds:
        assert ds.crs.to_string() == "EPSG:27700" and tuple(ds.bounds) == (1000, 2000, 1016, 2016) and ds.compression.name == "deflate"
        assert tuple(ds.read()[:, 15, 15]) == (7, 8, 9) and tuple(ds.read()[:, 40, 40]) == (100, 100, 100)
    assert [p.name for p in tmp_path.iterdir()] == ["imagery.tif"]               # no temp file left behind


def test_an_area_with_no_buildings_still_works(tmp_path, monkeypatch):
    path = _tif(tmp_path / "imagery.tif")
    monkeypatch.setattr(cars, "_remove", lambda rgb, features, px_per_m: (rgb, 0 if not features else -1))
    empty = gpd.GeoDataFrame({"building": []}, geometry=[], crs="EPSG:27700")
    assert cars.remove_cars(path, empty) == 0


def test_the_real_detector_runs_when_installed(tmp_path):
    pytest.importorskip("cardet")
    path = _tif(tmp_path / "imagery.tif", size=256, metres=64)
    assert cars.remove_cars(path, gpd.GeoDataFrame({"building": []}, geometry=[], crs="EPSG:27700")) == 0   # a flat grey square has no cars


def test_open_map_local_footprints_work_with_the_detectors_building_mask():
    # the failure seen in a real build: the mask reads each outline point as (x, y), and Open Map Local's polygons carry a Z
    blobs = pytest.importorskip("cardet.blobs")
    import geopandas as gpd
    from shapely.geometry import Polygon
    from pipeline.bundle import _local_buildings
    from pipeline.clean import clean_buildings
    raw = gpd.GeoDataFrame({"building": ["yes"]}, geometry=[Polygon([(1000, 2000, 7), (1020, 2000, 7), (1020, 2020, 7), (1000, 2020, 7)])], crs="EPSG:27700")
    features = _local_buildings(clean_buildings(raw), (1000, 2000))["features"]
    mask = blobs.building_mask(features, (80, 80), 2.0)                       # 40 m at 2 px per metre
    assert mask.shape == (80, 80) and mask[40, 40] and not mask[2, 70]
