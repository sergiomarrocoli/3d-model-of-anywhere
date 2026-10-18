import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from pipeline import build_area as ba
from pipeline import dtm
from pipeline.bundle import load_bundle
from pipeline.omlocal import squares_for_bbox

BBOX = (375000.0, 164500.0, 375100.0, 164600.0)


def _tif(path, arr, res=1.0, nodata=None, e0=BBOX[0], n0=BBOX[1]):
    h, w = arr.shape[-2:]
    count = 1 if arr.ndim == 2 else arr.shape[0]
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=count, dtype=arr.dtype.name,
                       crs="EPSG:27700", transform=from_origin(e0, n0 + h * res, res, res), nodata=nodata) as ds:
        ds.write(arr if arr.ndim == 3 else arr[None])
    return str(path)


def test_zero_fill_outside_ea_coverage_becomes_nodata(tmp_path):
    arr = np.full((10, 10), 20.0, dtype="float32")
    arr[:, :4] = 0.0
    p = _tif(tmp_path / "ea.tif", arr)
    dtm._mask_outside_coverage(p)
    m = np.ma.getmaskarray(rasterio.open(p).read(1, masked=True))
    assert m[:, :4].all() and not m[:, 4:].any()


def test_dtm_from_files_mosaics_and_clips(tmp_path):
    a = _tif(tmp_path / "a.tif", np.full((60, 60), 10.0, dtype="float32"), e0=BBOX[0] - 10, n0=BBOX[1] - 10)
    b = _tif(tmp_path / "b.tif", np.full((60, 60), 30.0, dtype="float32"), e0=BBOX[0] + 40, n0=BBOX[1] - 10)
    out = dtm.dtm_from_files([a, b], BBOX, tmp_path / "out.tif")
    ds = rasterio.open(out)
    z = ds.read(1)
    assert ds.shape == (100, 100) and tuple(ds.bounds) == BBOX
    assert z[50, 10] == pytest.approx(10.0) and z[50, 90] == pytest.approx(30.0)


def test_dtm_from_files_rejects_wrong_crs(tmp_path):
    p = tmp_path / "wgs.tif"
    with rasterio.open(p, "w", driver="GTiff", width=4, height=4, count=1, dtype="float32", crs="EPSG:4326",
                       transform=from_origin(0, 4, 1, 1)) as ds:
        ds.write(np.zeros((1, 4, 4), dtype="float32"))
    with pytest.raises(ValueError, match="EPSG:27700"):
        dtm.dtm_from_files([str(p)], BBOX, tmp_path / "o.tif")


def test_squares_for_bbox_spans_grid_squares():
    assert squares_for_bbox((375000, 164500, 375500, 165000)) == ["ST"]
    corner = squares_for_bbox((299900, 199900, 300100, 200100))  # straddles the 300 km E / 200 km N lines
    assert len(corner) == 4 and "ST" in corner and "SO" in corner


@pytest.fixture
def stubbed(tmp_path, monkeypatch):
    """No-network pipeline: flat 50 m DTM from Terrain 50 stub, grey imagery, configurable buildings."""
    def fake_fetch_dtm(bbox, out):
        _tif(out, np.full((100, 100), -9999.0, dtype="float32"), nodata=-9999.0, e0=bbox[0], n0=bbox[1])
    monkeypatch.setattr(ba.dtm, "fetch_dtm", fake_fetch_dtm)
    monkeypatch.setattr(ba.wales_lidar, "fetch_wales_lidar", lambda *a, **k: None)  # no Welsh tiles unless a test says so
    monkeypatch.setattr(ba.terrain_fill, "terrain50",
                        lambda bbox, cache=None: (np.full((20, 20), 50.0, dtype="float32"),
                                                  from_origin(bbox[0] - 300, bbox[3] + 300, 50, 50)))

    def fake_imagery(bbox, out, size=None, source=None):
        _tif(out, np.full((3, 128, 128), 128, dtype="uint8"), res=100 / 128, e0=bbox[0], n0=bbox[1])
        return out
    monkeypatch.setattr(ba.imagery, "fetch_imagery", fake_imagery)
    monkeypatch.setattr(ba.landcover, "fetch_elements", lambda bbox: [])   # no network in tests

    calls = []

    def fake_osm(bbox, out):
        calls.append("osm")
        gpd.GeoDataFrame({"osm_id": []}, geometry=[], crs="EPSG:27700").to_file(out, driver="GeoJSON")
        return out
    monkeypatch.setattr(ba.buildings, "fetch_buildings", fake_osm)
    return tmp_path, calls


def test_falls_back_to_omlocal_when_osm_empty(stubbed, monkeypatch):
    tmp, calls = stubbed
    from shapely.geometry import box
    oml = gpd.GeoDataFrame({"building": ["yes"], "osm_id": ["oml/0"]},
                           geometry=[box(375010, 164510, 375030, 164530)], crs="EPSG:27700")
    monkeypatch.setattr(ba.omlocal, "fetch_omlocal_buildings", lambda bbox, out=None, cache=None: oml)
    s = ba.build_area(BBOX, "t", tmp / "b", work_root=tmp / "w")
    assert s["buildings_source"] == "OS Open Map Local" and s["buildings"] == 1
    assert s["dtm_source"] == "OS Terrain 50 only" and s["has_dsm"] is False
    assert s["height_sources"] == {"default": 1}
    meta, z, _, fc = load_bundle(s["bundle"])
    assert np.allclose(z, 50) and len(fc["features"]) == 1 and fc["features"][0]["properties"]["height"] == 6.0
    assert any("Open Map Local" in c or "OS data" in c for c in meta["attribution"])


def test_empty_area_still_writes_valid_bundle(stubbed, monkeypatch):
    tmp, _ = stubbed
    monkeypatch.setattr(ba.omlocal, "fetch_omlocal_buildings",
                        lambda bbox, out=None, cache=None: gpd.GeoDataFrame({"osm_id": []}, geometry=[], crs="EPSG:27700"))
    s = ba.build_area(BBOX, "empty", tmp / "b", work_root=tmp / "w")
    meta, z, rgb, fc = load_bundle(s["bundle"])
    assert s["buildings"] == 0 and fc["features"] == [] and meta["buildings"]["count"] == 0


def test_uses_welsh_lidar_with_dsm_when_ea_has_no_coverage(stubbed, monkeypatch):
    tmp, _ = stubbed
    from shapely.geometry import box
    ground = np.full((100, 100), 100.0, dtype="float32")
    roof = ground.copy(); roof[40:60, 40:60] += 9.0      # a 9 m building at local x/y 40-60

    def fake_wales(bbox, out, kind="dtm", cache=None):
        _tif(out, ground if kind == "dtm" else roof, nodata=-9999.0, e0=bbox[0], n0=bbox[1])
        return out
    monkeypatch.setattr(ba.wales_lidar, "fetch_wales_lidar", fake_wales)
    oml = gpd.GeoDataFrame({"building": ["yes"], "osm_id": ["oml/0"]},
                           geometry=[box(BBOX[0] + 40, BBOX[1] + 40, BBOX[0] + 60, BBOX[1] + 60)], crs="EPSG:27700")
    monkeypatch.setattr(ba.omlocal, "fetch_omlocal_buildings", lambda bbox, out=None, cache=None: oml)
    s = ba.build_area(BBOX, "w", tmp / "b", work_root=tmp / "w")
    assert s["dtm_source"] == "Welsh Government LiDAR" and s["has_dsm"] is True and s["dtm_filled_pct"] == 0
    assert s["height_sources"] == {"lidar": 1}
    meta, z, _, fc = load_bundle(s["bundle"])
    assert fc["features"][0]["properties"]["height"] == pytest.approx(9.0) and np.allclose(z, 100)
    assert any("Welsh Government" in c for c in meta["attribution"])
