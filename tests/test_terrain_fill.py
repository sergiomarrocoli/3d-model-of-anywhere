import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from pipeline import terrain_fill
from pipeline.terrain_fill import fill_dtm, tile_name, tiles_for_bbox


def test_tile_name():
    assert tile_name(375000, 164500) == "st76"   # Bath
    assert tile_name(325000, 675000) == "nt27"   # Edinburgh
    assert tile_name(530000, 180000) == "tq38"   # London
    assert tile_name(260000, 200000) == "sn60"   # Wales


def test_tiles_for_bbox():
    assert tiles_for_bbox((375000, 164500, 375500, 165000)) == ["st76"]
    assert tiles_for_bbox((370000, 160000, 380000, 170000)) == ["st76"]  # exactly one tile
    assert sorted(tiles_for_bbox((379800, 169800, 380200, 170200))) == ["st76", "st77", "st86", "st87"]


def _write(path, arr, res, nodata=-9999.0):
    h, w = arr.shape
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                       crs="EPSG:27700", transform=from_origin(1000, 1000 + h * res, res, res), nodata=nodata) as ds:
        ds.write(arr.astype("float32"), 1)
    return str(path)


@pytest.fixture
def flat_terrain50(monkeypatch):
    """Terrain 50 stub: a flat 50 m surface at 7.0 m over a large area."""
    def fake(bbox, cache=None):
        return np.full((40, 40), 7.0, dtype="float32"), from_origin(bbox[0] - 500, bbox[3] + 500, 50, 50)
    monkeypatch.setattr(terrain_fill, "terrain50", fake)


def test_fills_only_nodata(tmp_path, flat_terrain50):
    arr = np.full((20, 20), 100.0)
    arr[5:10, 5:10] = -9999.0
    out = tmp_path / "out.tif"
    frac = fill_dtm(_write(tmp_path / "in.tif", arr, 1), out)
    res = rasterio.open(out).read(1)
    assert frac == pytest.approx(25 / 400)
    assert np.allclose(res[5:10, 5:10], 7.0) and np.allclose(res[:5], 100.0)
    assert not np.isnan(res).any()


def test_no_gaps_skips_terrain50(tmp_path, monkeypatch):
    monkeypatch.setattr(terrain_fill, "terrain50", lambda *a, **k: pytest.fail("should not be called"))
    assert fill_dtm(_write(tmp_path / "in.tif", np.full((20, 20), 50.0), 1), tmp_path / "out.tif") == 0


def test_resamples_to_1m(tmp_path, flat_terrain50):
    out = tmp_path / "out.tif"
    fill_dtm(_write(tmp_path / "in.tif", np.full((10, 10), 50.0), 2), out)
    ds = rasterio.open(out)
    assert ds.res == (1.0, 1.0) and ds.shape == (20, 20) and np.allclose(ds.read(1), 50.0)
