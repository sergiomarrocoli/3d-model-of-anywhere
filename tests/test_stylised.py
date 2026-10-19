import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from pipeline import landcover as lc
from pipeline import stylised

BOX = (1000.0, 2000.0, 1064.0, 2064.0)      # 64 m: a 256 pixel picture at 0.25 m


def _tif(path, arr):
    with rasterio.open(path, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1, dtype="float32", crs="EPSG:27700",
                       transform=from_origin(BOX[0], BOX[3], 1.0, 1.0)) as ds:
        ds.write(arr.astype("float32")[None])
    return str(path)


def _scene(tmp_path, with_dsm=True):
    """64 m square: grass, a road across the south, water in the north east, a 10 m tall 10 x 10 m building in the middle."""
    classes = np.full((128, 128), lc.GRASS, np.uint8)            # 0.5 m cells, rows north to south
    classes[100:112, :] = lc.ROAD
    classes[5:25, 100:125] = lc.WATER
    classes[54:74, 54:74] = lc.BUILDING                          # 10 m x 10 m, from (1027, 2027) to (1037, 2037) in grid metres
    dtm = np.full((64, 64), 100.0); dsm = dtm.copy(); dsm[27:37, 27:37] += 10.0
    houses = gpd.GeoDataFrame({"height": [10.0]}, geometry=[box(1027, 2027, 1037, 2037)], crs="EPSG:27700")
    return classes, _tif(tmp_path / "dtm.tif", dtm), (_tif(tmp_path / "dsm.tif", dsm) if with_dsm else None), houses


def _read(path):
    with rasterio.open(path) as ds:
        return np.moveaxis(ds.read(), 0, -1).astype(float), ds


def test_the_picture_is_on_the_same_grid_a_photo_would_be(tmp_path):
    classes, dtm, dsm, houses = _scene(tmp_path)
    assert stylised.output_size(BOX) == (256, 256)
    out = stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "i.tif")
    rgb, ds = _read(out)
    assert rgb.shape == (256, 256, 3) and str(ds.crs) == "EPSG:27700" and tuple(ds.bounds) == BOX and ds.dtypes[0] == "uint8"
    # sizes follow the photo's rule: 0.25 m a pixel, rounded to a whole number of 64 pixel blocks
    assert stylised.output_size((0, 0, 1000, 1000)) == (3968, 3968)               # what fetch_imagery gives a 1 km box
    assert stylised.output_size((0, 0, 1400, 2850)) == (5632, 11392)


def test_surfaces_get_their_colours(tmp_path):
    classes, dtm, dsm, houses = _scene(tmp_path)
    rgb, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "i.tif"))
    grass, road, water = rgb[150:190, 10:90].mean((0, 1)), rgb[205:215, 20:200].mean((0, 1)), rgb[30:70, 410 // 2:480 // 2].mean((0, 1))
    assert grass[1] > grass[0] and grass[1] > grass[2]                         # green
    assert road.max() - road.min() < 25 and road.mean() < grass.mean()          # dark and grey
    assert water[2] > water[0] + 25                                             # blue


def test_a_building_has_a_roof_colour_of_its_own_and_an_outline(tmp_path):
    classes, dtm, dsm, houses = _scene(tmp_path)
    rgb, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "i.tif"))
    roof = rgb[112:140, 112:140].mean((0, 1)); grass = rgb[150:190, 10:90].mean((0, 1))
    assert not (roof[1] > roof[0] and roof[1] > roof[2])                         # not grass-coloured
    assert abs(roof - grass).sum() > 60
    edge = rgb[108:111, 130:140].mean(); inside = rgb[118:130, 130:140].mean()
    assert edge < inside * 0.95                                                  # a darker line where the roof meets the ground


def test_the_sun_is_in_the_north_west_so_a_tall_building_throws_a_shadow_to_the_south_east(tmp_path):
    classes, dtm, dsm, houses = _scene(tmp_path)
    rgb, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "i.tif"))
    lit = rgb[110:150, 60:100].mean()                       # grass north west of the building
    shadowed = rgb[150:185, 150:190].mean()                 # grass south east of it: in the shadow of 10 m at 42 degrees (about 11 m long)
    far = rgb[150:185, 30:60].mean()                        # grass at the same distance south but clear of it
    assert shadowed < far * 0.85 and abs(lit - far) < far * 0.2
    flat, _ = _read(stylised.draw(classes, dtm, None, houses, BOX, tmp_path / "j.tif"))      # without a LiDAR surface there is no shadow
    assert abs(flat[150:185, 150:190].mean() - flat[150:185, 30:60].mean()) < flat.mean() * 0.1


def test_the_same_inputs_draw_the_same_picture(tmp_path):
    classes, dtm, dsm, houses = _scene(tmp_path)
    a, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "a.tif")); b, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "b.tif"))
    assert np.array_equal(a, b)
    c, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "c.tif", seed=99))
    assert not np.array_equal(a, c) and abs(a.mean() - c.mean()) < 3                # a different grain, the same picture


def test_a_thin_ring_of_tree_is_not_a_tree(tmp_path):
    classes, dtm, dsm, houses = _scene(tmp_path)
    classes[50:52, 40:90] = lc.TREE                                              # a 1 m hedge-thin strip the LiDAR read at a wall
    classes[20:40, 10:30] = lc.TREE                                              # a real clump, 10 m across
    rgb, _ = _read(stylised.draw(classes, dtm, dsm, houses, BOX, tmp_path / "i.tif"))
    strip, clump, grass = rgb[100:104, 120:170].mean((0, 1)), rgb[44:76, 24:56].mean((0, 1)), rgb[150:190, 10:90].mean((0, 1))      # 0.5 m cells are 2 x 2 pixels
    assert clump.mean() < grass.mean() * 0.8 and abs(strip - grass).sum() < 40


def test_hillshade_lights_the_slope_that_faces_the_sun():
    y, x = np.mgrid[0:50, 0:50].astype(float)
    assert stylised.hillshade(0.5 * x, 1.0)[25, 25] > stylised.hillshade(-0.5 * x, 1.0)[25, 25]     # rising to the east faces west, towards a sun in the north west
    assert stylised.hillshade(0.5 * y, 1.0)[25, 25] > stylised.hillshade(-0.5 * y, 1.0)[25, 25]     # rows run south: rising to the south faces north
    assert abs(stylised.hillshade(np.zeros((9, 9)), 1.0)[4, 4] - np.sin(np.radians(stylised.SUN_ALTITUDE_DEG))) < 1e-6   # flat ground is lit by the sun's height alone


def test_shadows_fall_away_from_the_sun():
    z = np.zeros((60, 60)); z[20, 20] = 10.0                                      # a post, 10 m tall
    s = stylised.shadows(z, 1.0)
    assert s[22, 22] and s[25, 25] and not s[30, 30]                              # 10 m at 42 degrees throws about 11 m: dark 7 m (25, 25) along the diagonal, clear again by 14 m (30, 30)
    assert not s[15, 15] and not s[20, 40] and not s[40, 20]                      # north west of it, and straight east and south, are lit
