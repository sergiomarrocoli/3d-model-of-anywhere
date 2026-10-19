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


@pytest.fixture
def lidar_town(stubbed, monkeypatch):
    """A Welsh-LiDAR area with two mapped buildings (OSM), one that only Open Map Local has (the LiDAR sees it) and one it also has that the LiDAR does not see."""
    from shapely.geometry import box
    tmp, _ = stubbed
    ground = np.full((100, 100), 100.0, dtype="float32")
    roof = ground.copy()
    for a, b in ((10, 25), (40, 55), (70, 85)):
        roof[100 - b:100 - a, a:b] += 9.0           # raster row 0 is the north edge, so this is local y a..b
    monkeypatch.setattr(ba.wales_lidar, "fetch_wales_lidar", lambda bbox, out, kind="dtm", cache=None:
                        _tif(out, ground if kind == "dtm" else roof, nodata=-9999.0, e0=bbox[0], n0=bbox[1]))
    sq = lambda a, b: box(BBOX[0] + a, BBOX[1] + a, BBOX[0] + b, BBOX[1] + b)
    osm = gpd.GeoDataFrame({"building": ["yes", "yes"], "osm_id": ["way/1", "way/2"]}, geometry=[sq(10, 25), sq(40, 55)], crs="EPSG:27700")
    oml = gpd.GeoDataFrame({"building": ["yes"] * 3, "osm_id": ["oml/0", "oml/1", "oml/2"]},
                           geometry=[sq(10, 25), sq(70, 85), box(BBOX[0] + 2, BBOX[1] + 90, BBOX[0] + 12, BBOX[1] + 98)], crs="EPSG:27700")
    monkeypatch.setattr(ba.buildings, "fetch_buildings", lambda bbox, out: (osm.to_file(out, driver="GeoJSON"), out)[1])
    monkeypatch.setattr(ba.omlocal, "fetch_omlocal_buildings", lambda bbox, out=None, cache=None: oml)
    monkeypatch.setattr(ba.omlocal, "fetch_omlocal_roads", lambda bbox, cache=None: gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs="EPSG:27700"))
    return tmp


def test_fill_footprints_adds_open_map_local_buildings_the_lidar_confirms(lidar_town):
    s = ba.build_area(BBOX, "f", lidar_town / "b", work_root=lidar_town / "w", fill_footprints=True)
    _, _, _, fc = load_bundle(s["bundle"])
    assert s["buildings"] == 3 and s["footprints_from_omlocal"] == 1          # oml/0 is OSM's way/1 again, oml/2 has no LiDAR behind it
    assert sorted(f["properties"]["osm_id"] for f in fc["features"]) == ["oml/1", "way/1", "way/2"]
    plain = ba.build_area(BBOX, "p", lidar_town / "b", work_root=lidar_town / "w")
    assert plain["buildings"] == 2 and "footprints_from_omlocal" not in plain          # off by default


def test_register_warps_the_photo_and_tells_the_viewer(lidar_town, monkeypatch):
    monkeypatch.setattr(ba.register, "fit_registration", lambda *a, **k: {"ground": [0.5, 1.0], "lean": [0.3, 0.0], "buildings_used": 2, "ground_from": "roads"})
    s = ba.build_area(BBOX, "r", lidar_town / "b", work_root=lidar_town / "w", register_imagery=True)
    meta, _, _, _ = load_bundle(s["bundle"])
    assert (lidar_town / "w" / "r" / "imagery_registered.tif").exists() and s["registration"]["lean"] == [0.3, 0.0]
    assert meta["imagery_registration"]["ground"] == [0.5, 1.0] and meta["imagery_lean"] == {"ground": [0, 0], "perMetre": [0, 0]}      # so roofs are not shifted twice


def test_register_with_nothing_to_measure_leaves_the_bundle_alone(lidar_town):
    s = ba.build_area(BBOX, "n", lidar_town / "b", work_root=lidar_town / "w", register_imagery=True)      # two buildings: too few to fit a lean
    meta, _, _, _ = load_bundle(s["bundle"])
    assert s["registration"]["lean"] == [0.0, 0.0] and "imagery_lean" not in meta


def test_flags_that_cannot_act_say_so_and_change_nothing(stubbed, monkeypatch, capsys):
    tmp, _ = stubbed
    monkeypatch.setattr(ba.omlocal, "fetch_omlocal_buildings", lambda bbox, out=None, cache=None: gpd.GeoDataFrame({"osm_id": []}, geometry=[], crs="EPSG:27700"))
    s = ba.build_area(BBOX, "x", tmp / "b", work_root=tmp / "w", fill_footprints=True, register_imagery=True)      # no LiDAR surface, no buildings
    out = capsys.readouterr().out
    assert "not registered" in out and "registration" not in s and s["buildings"] == 0


def test_stylised_imagery_is_drawn_from_open_data_with_no_photo_and_no_lean(lidar_town, monkeypatch):
    def no_photo(*a, **k):
        raise AssertionError("a stylised build must not fetch a photograph")
    monkeypatch.setattr(ba.imagery, "fetch_imagery", no_photo)
    monkeypatch.setattr(ba.register, "fit_registration", no_photo)                  # nothing to register
    monkeypatch.setattr(ba.cars, "remove_cars", no_photo)                           # no cars to remove
    s = ba.build_area(BBOX, "s", lidar_town / "b", work_root=lidar_town / "w", imagery_source="stylised", register_imagery=True, remove_cars=True, fill_footprints=True)
    meta, _, rgb, fc = load_bundle(s["bundle"])
    assert s["imagery_source"] == "stylised" and meta["imagery_source"] == "stylised" and "registration" not in s and "cars_removed" not in meta
    assert meta["imagery_lean"] == {"ground": [0, 0], "perMetre": [0, 0]}           # drawn from the footprints: the viewer must not shift roofs
    assert any("no aerial photography" in c for c in meta["attribution"]) and not any("Esri" in c for c in meta["attribution"])
    assert rgb.shape[:2] == (384, 384) and rgb.std() > 5                           # a real picture, on the grid a photo would have
    assert len(fc["features"]) == 3                                                # the footprints are the same


def test_the_default_is_the_photograph_and_the_bundle_says_so(lidar_town):
    s = ba.build_area(BBOX, "p", lidar_town / "b", work_root=lidar_town / "w")
    meta, _, _, _ = load_bundle(s["bundle"])
    assert meta["imagery_source"] == "esri" and "imagery_lean" not in meta
