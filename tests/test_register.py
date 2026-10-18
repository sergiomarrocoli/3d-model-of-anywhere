import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from pipeline import register

SIZE, RES = 400, 0.5          # a 400 m square at 0.5 m per pixel
LEAN, GROUND = (0.3, -0.1), (0.0, 0.0)


def _photo(path, footprints, shift):
    """A grey photo with a bright square for each footprint, drawn where `shift(height)` metres (east, north) moves it."""
    img = np.full((3, int(SIZE / RES), int(SIZE / RES)), 80, dtype="uint8")
    for geom, h in footprints:
        e, n = shift(h); x0, y0, x1, y1 = geom.bounds
        c0, c1 = int((x0 + e) / RES), int((x1 + e) / RES); r0, r1 = int((SIZE - (y1 + n)) / RES), int((SIZE - (y0 + n)) / RES)
        img[:, r0:r1, c0:c1] = 220
    with rasterio.open(path, "w", driver="GTiff", height=img.shape[1], width=img.shape[2], count=3, dtype="uint8", crs="EPSG:27700", transform=from_origin(0, SIZE, RES, RES)) as ds:
        ds.write(img)
    return img


def _town():
    rng = np.random.default_rng(3)
    cells = [(x, y) for x in range(40, 340, 60) for y in range(40, 340, 60)]
    fps = [(box(x, y, x + 12, y + 12), float(rng.uniform(4, 14))) for x, y in cells]
    return fps, gpd.GeoDataFrame({"height": [h for _, h in fps]}, geometry=[g for g, _ in fps], crs="EPSG:27700")


def test_fit_recovers_the_lean_from_the_photo(tmp_path):
    fps, b = _town()
    _photo(tmp_path / "p.tif", fps, lambda h: (GROUND[0] + h * LEAN[0], GROUND[1] + h * LEAN[1]))
    lean, used = register.fit_lean(b, tmp_path / "p.tif", list(GROUND))
    assert used == len(fps)
    assert abs(lean[0] - LEAN[0]) < 0.1 and abs(lean[1] - LEAN[1]) < 0.1


def test_warp_puts_each_roof_back_on_its_footprint(tmp_path):
    fps, b = _town()
    raw = _photo(tmp_path / "p.tif", fps, lambda h: (h * LEAN[0], h * LEAN[1]))
    register.warp_imagery(tmp_path / "p.tif", b, list(GROUND), list(LEAN), tmp_path / "w.tif")
    with rasterio.open(tmp_path / "w.tif") as ds:
        out = ds.read(1).astype(float)
    strip = lambda img, g: img[int((SIZE - g.bounds[3]) / RES) + 4:int((SIZE - g.bounds[1]) / RES) - 4, int(g.bounds[2] / RES) + 1:int(g.bounds[2] / RES) + 2].mean()     # the pixels just east of the footprint
    for geom, h in fps:
        x0, y0, x1, y1 = geom.bounds
        assert out[int((SIZE - y1) / RES) + 4:int((SIZE - y0) / RES) - 4, int(x0 / RES) + 4:int(x1 / RES) - 4].mean() > 200      # the bright roof now sits on its footprint
        assert strip(raw[0].astype(float), geom) > 150 and strip(out, geom) < 100            # it had spilled east of it, and no longer does


def test_too_few_buildings_to_fit_means_no_correction(tmp_path):
    fps, b = _town()
    _photo(tmp_path / "p.tif", fps, lambda h: (0, 0))
    r = register.fit_registration(b.iloc[:5], tmp_path / "p.tif", tmp_path / "p.tif")
    assert r["lean"] == [0.0, 0.0] and r["ground_from"] == "none"
