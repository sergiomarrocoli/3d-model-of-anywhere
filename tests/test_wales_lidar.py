import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from pipeline import wales_lidar as wl

BBOX = (310700.0, 291130.0, 311200.0, 291630.0)


def _feature(grid, e0, n0, date="17-03-2021", dtm=True):
    ring = [[e0, n0], [e0, n0 + 1000], [e0 + 1000, n0 + 1000], [e0 + 1000, n0], [e0, n0]]
    props = {"british_gr": grid, "date": date, "dsm_link": f"host/dsm/{grid}-{date}.tif"}
    if dtm:
        props["dtm_link"] = f"host/dtm/{grid}-{date}.tif"
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": props}


class _Resp:
    def __init__(self, features): self._f = features
    def raise_for_status(self): pass
    def json(self): return {"features": self._f}


def _catalogue(monkeypatch, features):
    seen = {}
    def fake_get(url, params=None, timeout=None, **kw):
        seen.update(params or {})
        return _Resp(features)
    monkeypatch.setattr(wl.requests, "get", fake_get)
    return seen


def test_catalogue_query_and_filtering(monkeypatch):
    seen = _catalogue(monkeypatch, [
        _feature("SO1091", 310000, 291000),
        _feature("SO1191", 311000, 291000, date="01-01-2020"),
        _feature("SO1191", 311000, 291000, date="17-03-2021"),   # newer delivery of the same grid ref wins
        _feature("SO1090", 310000, 290000),                      # ends at N 291000, below the box (starts 291130)
        _feature("SO1292", 312000, 292000),                      # far away
    ])
    tiles = wl.catalogue_tiles(BBOX)
    assert [t["british_gr"] for t in tiles] == ["SO1091", "SO1191"]
    assert tiles[1]["date"] == "17-03-2021"
    assert seen["bbox"] == "310700.0,291130.0,311200.0,291630.0,EPSG:27700" and seen["srsName"] == "EPSG:27700"


def test_edge_touching_tiles_are_skipped(monkeypatch):
    _catalogue(monkeypatch, [_feature("SO1190", 311000, 290000), _feature("SO1091", 310000, 291000)])
    # box starts exactly on E 311000 / N 291000: SO1190 (below) and SO1191's neighbour on the west share only an edge with it
    tiles = wl.catalogue_tiles((311000.0, 291000.0, 311500.0, 291500.0))
    assert [t["british_gr"] for t in tiles] == []  # SO1190 touches the south edge, SO1091 the west edge


def test_no_tiles_returns_none(monkeypatch, tmp_path):
    _catalogue(monkeypatch, [])
    assert wl.fetch_wales_lidar(BBOX, tmp_path / "o.tif", cache=tmp_path / "c") is None


def test_rejects_unknown_kind(tmp_path):
    with pytest.raises(ValueError):
        wl.fetch_wales_lidar(BBOX, tmp_path / "o.tif", kind="dxm")


def test_downloads_caches_mosaics_and_clips(monkeypatch, tmp_path):
    _catalogue(monkeypatch, [_feature("SO1091", 310000, 291000), _feature("SO1191", 311000, 291000)])
    downloads = []

    def fake_download(url, dest):
        downloads.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        e0 = 310000 if "SO1091" in url else 311000
        with rasterio.open(dest, "w", driver="GTiff", width=1000, height=1000, count=1, dtype="float32", crs="EPSG:27700",
                           transform=from_origin(e0, 292000, 1, 1), nodata=-9999.0) as ds:
            ds.write(np.full((1, 1000, 1000), 100.0 if e0 == 310000 else 200.0, dtype="float32"))
        return dest
    monkeypatch.setattr(wl, "_download", fake_download)
    out = wl.fetch_wales_lidar(BBOX, tmp_path / "o.tif", cache=tmp_path / "c")
    z = rasterio.open(out).read(1)
    assert z.shape == (500, 500) and downloads == ["host/dtm/SO1091-17-03-2021.tif", "host/dtm/SO1191-17-03-2021.tif"]
    assert z[250, 100] == 100 and z[250, 400] == 200      # west of E 311000 is tile 1, east is tile 2
    wl.fetch_wales_lidar(BBOX, tmp_path / "o2.tif", kind="dsm", cache=tmp_path / "c")
    assert downloads[-1].startswith("host/dsm/")


def test_download_is_atomic_and_cached(monkeypatch, tmp_path):
    calls = []

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def raise_for_status(self): pass
        def iter_content(self, n): yield b"abc"; yield b"def"
    monkeypatch.setattr(wl.requests, "get", lambda url, **kw: calls.append(url) or R())
    dest = tmp_path / "d" / "t.tif"
    wl._download("host/x/t.tif", dest)
    wl._download("host/x/t.tif", dest)
    assert dest.read_bytes() == b"abcdef" and calls == ["https://host/x/t.tif"] and not list(dest.parent.glob("*.part"))
