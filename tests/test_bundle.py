import json

import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from pipeline.bundle import encode_heightmap, load_bundle, write_bundle

E0, N0 = 375000.0, 164500.0


def _raster(path, arr, res, bands):
    h, w = arr.shape[-2:]
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=bands, dtype=arr.dtype.name,
                       crs="EPSG:27700", transform=from_origin(E0, N0 + h * res, res, res)) as ds:
        ds.write(arr if bands > 1 else arr[None] if arr.ndim == 2 else arr)
    return str(path)


@pytest.fixture
def inputs(tmp_path):
    z = (20 + np.arange(40)[None, :] * 0.5 + np.arange(40)[:, None] * 0.1).astype("float32")
    rgb = np.random.default_rng(0).integers(0, 255, (3, 80, 80), dtype=np.uint8)
    b = gpd.GeoDataFrame({"building": ["yes"], "osm_id": ["way/1"], "height": [9.5], "base_z": [21.0],
                          "height_source": ["lidar"], "extra": ["dropped"]},
                         geometry=[box(E0 + 10, N0 + 5, E0 + 20.123456, N0 + 15)], crs="EPSG:27700")
    return _raster(tmp_path / "dtm.tif", z, 1, 1), _raster(tmp_path / "img.tif", rgb, 0.5, 3), b, z


def test_roundtrip(tmp_path, inputs):
    dtm, img, b, z = inputs
    root = write_bundle(tmp_path, "t1", dtm, img, b, ["A", "B", "A"])
    assert root.name == "area_t1"
    meta, z2, rgb2, fc = load_bundle(root)
    assert meta["bbox"] == [E0, N0, E0 + 40, N0 + 40] and meta["origin"] == [E0, N0]
    assert meta["attribution"] == ["A", "B"] and (root / "ATTRIBUTION.txt").read_text() == "A\nB\n"
    assert np.abs(z2 - z).max() < 1e-3 and rgb2.shape == (80, 80, 3)
    ring = fc["features"][0]["geometry"]["coordinates"][0]
    assert min(p[0] for p in ring) == 10 and max(p[0] for p in ring) == 20.12  # local metres, cm precision
    assert fc["features"][0]["properties"] == {"building": "yes", "osm_id": "way/1", "height": 9.5,
                                               "base_z": 21.0, "height_source": "lidar"}
    assert json.loads((root / "meta.json").read_text())["buildings"]["count"] == 1


def test_rows_run_north_to_south(tmp_path, inputs):
    dtm, img, b, z = inputs
    meta, z2, _, _ = load_bundle(write_bundle(tmp_path, "t2", dtm, img, b, []))
    assert z2[0, 0] == pytest.approx(z[0, 0], abs=1e-3) and z2[-1, 0] == pytest.approx(z[-1, 0], abs=1e-3)


def test_rejects_mismatched_extent_and_nodata(tmp_path, inputs):
    dtm, img, b, _ = inputs
    big = _raster(tmp_path / "big.tif", np.zeros((3, 100, 100), dtype=np.uint8), 0.5, 3)
    with pytest.raises(ValueError, match="different extents"):
        write_bundle(tmp_path, "t3", dtm, big, b, [])
    with pytest.raises(ValueError, match="nodata"):
        encode_heightmap(np.array([[1.0, np.nan]]))
    with pytest.raises(ValueError, match="27700"):
        write_bundle(tmp_path, "t4", dtm, img, b.set_crs("EPSG:4326", allow_override=True), [])


def test_surfacemap_written_from_dsm(tmp_path, inputs):
    dtm, img, b, z = inputs
    dsm_arr = z + 6.0                       # a uniform 6 m "roof" everywhere ...
    dsm_arr[0, 0] = -9999                   # ... except a nodata pixel, filled from the ground
    dsm_arr[1, 1] = z[1, 1] - 3             # and a pixel below ground, lifted to the ground
    dsm = str(tmp_path / "dsm.tif")
    with rasterio.open(dsm, "w", driver="GTiff", width=40, height=40, count=1, dtype="float32", nodata=-9999,
                       crs="EPSG:27700", transform=from_origin(E0, N0 + 40, 1, 1)) as ds:
        ds.write(dsm_arr.astype("float32")[None])
    root = write_bundle(tmp_path, "t5", dtm, img, b, [], dsm)
    meta = json.loads((root / "meta.json").read_text())
    from pipeline.bundle import decode_heightmap
    s = meta["surfacemap"]
    zs = decode_heightmap(root / s["file"], s["min"], s["max"])
    assert s["width"] == 40 and zs.shape == (40, 40)
    assert zs[10, 10] == pytest.approx(z[10, 10] + 6, abs=0.01)
    assert zs[0, 0] == pytest.approx(z[0, 0], abs=0.01)
    assert zs[1, 1] == pytest.approx(z[1, 1], abs=0.01)
    # a rebuild without a DSM removes the stale surfacemap and meta entry
    root = write_bundle(tmp_path, "t5", dtm, img, b, [])
    assert not (root / "surfacemap.png").exists() and "surfacemap" not in json.loads((root / "meta.json").read_text())
