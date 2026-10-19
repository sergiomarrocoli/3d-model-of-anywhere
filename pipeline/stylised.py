"""A stylised ground texture drawn from open data, instead of an aerial photograph (`--imagery stylised`).

The photo that drapes the terrain is development-use only and the open satellite data is too coarse to look at, so for demos and
images that can be published the texture is drawn: the land cover raster (road, paved, grass, bare, trees, water, buildings) gives the
colours, each building gets a roof colour of its own, the LiDAR surface lights it from the north west (pitched roofs, tree canopies and
slopes shade) and casts shadows, and there is a grain per surface and a darker line where roads, water and roofs meet the ground.
Crisp at any zoom, and it matches the footprints exactly, so there is nothing to register and no cars to remove.
"""
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from scipy import ndimage as ndi

from pipeline import landcover as lc

RES_M = 0.25                    # ground metres per pixel, as the photo is (the size is rounded to a multiple of 64 pixels in the same way)
SUN_AZIMUTH_DEG, SUN_ALTITUDE_DEG = 315.0, 42.0          # the sun in the north west, as maps are lit
SHADOW_LENGTH_M = 45.0
SHADOW_DARKNESS = 0.6
ATTRIBUTION = "Ground texture drawn from OpenStreetMap, OS Open Map Local and LiDAR data (no aerial photography)"

PALETTE = {
    lc.UNKNOWN: (112, 150, 84), lc.ROAD: (74, 78, 86), lc.PAVED: (164, 164, 160), lc.GRASS: (112, 150, 84),
    lc.BARE: (176, 152, 118), lc.TREE: (58, 100, 62), lc.WATER: (84, 140, 188), lc.BUILDING: (150, 110, 96),
}
ROOFS = [(176, 94, 72), (96, 102, 114), (168, 144, 122), (128, 66, 58), (112, 88, 78), (140, 148, 154), (190, 120, 84)]   # terracotta, slate, buff, brick, brown, grey, tile
GRAIN = {lc.GRASS: (0.10, 7.0, 1.4), lc.UNKNOWN: (0.10, 7.0, 1.4), lc.BARE: (0.10, 5.0, 1.0), lc.PAVED: (0.05, 3.0, 0.6), lc.ROAD: (0.035, 3.0, 0.5),
         lc.WATER: (0.06, 6.0, 2.0), lc.TREE: (0.10, 4.0, 1.0), lc.BUILDING: (0.03, 3.0, 0.5)}      # (strength, big blotches in m, fine grain in m)
OUTLINE_DARKNESS = 0.78
MIN_TREE_WIDTH_CELLS = 5                  # a patch of 'tree' narrower than this (2.5 m at the land cover's 0.5 m cells) is a hedge or the LiDAR reading a wall's edge, not a tree: it is drawn as grass
OUTLINED = (lc.ROAD, lc.WATER, lc.BUILDING)                  # where one of these meets anything else there is a darker line


def output_size(bbox, res=RES_M):
    """(width, height) in pixels, rounded to a multiple of 64 like the photo's, so the texture and a photo cover the same grid."""
    left, bottom, right, top = bbox
    return round((right - left) / res / 64) * 64 or 64, round((top - bottom) / res / 64) * 64 or 64


def hillshade(z, cell_m, azimuth_deg=SUN_AZIMUTH_DEG, altitude_deg=SUN_ALTITUDE_DEG):
    """How lit each cell is (0 to 1) by a sun at `azimuth_deg` (clockwise from north) and `altitude_deg`; rows run north to south, so north is up."""
    dz_dnorth, dz_deast = np.gradient(z, cell_m)
    dz_dnorth = -dz_dnorth                                         # rows go south: flip to north
    norm = np.sqrt(dz_deast ** 2 + dz_dnorth ** 2 + 1.0)
    az, alt = np.radians(azimuth_deg), np.radians(altitude_deg)
    light = np.array([np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)])
    return np.clip((-dz_deast * light[0] - dz_dnorth * light[1] + light[2]) / norm, 0, 1)


def shadows(z, cell_m, altitude_deg=SUN_ALTITUDE_DEG, length_m=SHADOW_LENGTH_M):
    """True where something taller between the cell and the sun (to its north west) blocks it. Steps one cell along the diagonal at a time."""
    rise_per_step = np.tan(np.radians(altitude_deg)) * cell_m * np.sqrt(2.0)
    out = np.zeros(z.shape, bool)
    for k in range(1, int(length_m / (cell_m * np.sqrt(2.0))) + 1):
        shifted = np.full(z.shape, -np.inf, dtype=z.dtype)
        shifted[k:, k:] = z[:-k, :-k]                            # the cell k steps to the north west
        out |= shifted > z + rise_per_step * k
    return out


def _noise(shape, scale_px, rng):
    """Soft random values in about -1..1 with blotches `scale_px` across."""
    coarse = rng.standard_normal((max(2, int(shape[0] / scale_px) + 2), max(2, int(shape[1] / scale_px) + 2))).astype("float32")
    big = ndi.zoom(coarse, (shape[0] / coarse.shape[0] * 1.0, shape[1] / coarse.shape[1] * 1.0), order=3, mode="nearest")
    out = np.zeros(shape, "float32")
    h, w = min(shape[0], big.shape[0]), min(shape[1], big.shape[1])
    out[:h, :w] = big[:h, :w]
    if h < shape[0]: out[h:, :w] = big[h - 1:h, :w]
    if w < shape[1]: out[:, w:] = out[:, w - 1:w]
    return np.clip(out / 1.6, -1.5, 1.5)


def _resample(a, shape, order=1):
    """Resize to `shape` (rows, cols): bilinear, or bicubic (order=3) for smooth lighting."""
    return ndi.zoom(a, (shape[0] / a.shape[0], shape[1] / a.shape[1]), order=order, mode="nearest")[:shape[0], :shape[1]]


def draw(classes, dtm_path, dsm_path, buildings, bbox, out_path, seed=7):
    """Write the texture as an RGB GeoTIFF (EPSG:27700) covering `bbox` and return its path.
    classes: the land cover raster (uint8, rows north to south, any resolution) for the same box; buildings: GeoDataFrame in EPSG:27700 (may be empty);
    dsm_path may be None (no LiDAR surface: no lighting from roofs and trees, no shadows)."""
    rng = np.random.default_rng(seed)
    classes = classes.copy()
    tree = classes == lc.TREE
    classes[tree & ~ndi.binary_opening(tree, np.ones((MIN_TREE_WIDTH_CELLS, MIN_TREE_WIDTH_CELLS), bool))] = lc.GRASS     # drops the thin ring the LiDAR sees round a wall
    left, bottom, right, top = bbox
    W, H = output_size(bbox)
    tf = from_bounds(left, bottom, right, top, W, H)

    # colours: the class under every pixel, and a colour of its own for each roof
    rows = (np.arange(H) * classes.shape[0] // H)[:, None]; cols = (np.arange(W) * classes.shape[1] // W)[None, :]
    cls = classes[rows, cols]
    pal = np.zeros((256, 3), "float32")
    for k, v in PALETTE.items(): pal[k] = v
    img = pal[cls]
    ids = np.zeros((H, W), "int32")
    if len(buildings):
        ids = rasterize(((g, i + 1) for i, g in enumerate(buildings.geometry) if not g.is_empty), out_shape=(H, W), transform=tf, fill=0, dtype="int32")
        roof = np.array(ROOFS, "float32")[(ids[ids > 0] - 1) % len(ROOFS)]
        img[ids > 0] = roof
        cls = np.where(ids > 0, lc.BUILDING, cls)
    img = ndi.gaussian_filter(img, sigma=(0.7, 0.7, 0))             # soft edges, not stair-steps

    # light: the LiDAR surface (or the terrain alone) lit from the north west, with shadows
    cell = 1.0
    with rasterio.open(dtm_path) as d:
        dtm = d.read(1, masked=True).filled(np.nan).astype("float32"); cell = abs(d.transform.a)
    dtm = np.where(np.isnan(dtm), np.nanmean(dtm) if np.isfinite(dtm).any() else 0.0, dtm)
    dsm = dtm
    if dsm_path is not None:
        with rasterio.open(dsm_path) as s:
            surface = s.read(1, masked=True).filled(np.nan).astype("float32")
        dsm = np.where(np.isnan(surface), dtm, surface)
    flat = np.sin(np.radians(SUN_ALTITUDE_DEG))
    light = np.clip(ndi.gaussian_filter(hillshade(dsm, cell), 0.8) / flat, 0.55, 1.35)      # a touch of blur: the surface is 1 m cells, the picture 0.25 m pixels
    cast = ndi.gaussian_filter(shadows(dsm, cell).astype("float32"), 0.8) if dsm_path is not None else np.zeros_like(dsm)
    shade = _resample(light * (1 - (1 - SHADOW_DARKNESS) * cast), (H, W), order=3)
    tint = _resample(cast, (H, W))[..., None] * np.array([-0.05, -0.02, 0.06], "float32")            # shade is a touch bluer
    img = img * shade[..., None] * (1 + tint)

    # grain: a different strength and size for each surface; tree canopies also follow the LiDAR height
    pixel = RES_M
    for k, (strength, big, fine) in GRAIN.items():
        m = cls == k
        if not m.any(): continue
        grain = _noise((H, W), big / pixel, rng) * 0.65 + _noise((H, W), fine / pixel, rng) * 0.35
        img[m] *= (1 + strength * grain[m])[:, None]
    if dsm_path is not None:
        canopy = _resample(np.clip(dsm - dtm, 0, 25), (H, W))
        trees = cls == lc.TREE
        img[trees] *= (0.82 + 0.5 * np.clip(canopy[trees] / 18.0, 0, 1))[:, None]

    # a darker line where roads, water and roofs meet something else
    lines = np.zeros((H, W), bool)
    for dy, dx in ((0, 1), (1, 0)):
        a, b = cls[:H - dy, :W - dx], cls[dy:, dx:]
        diff = (a != b) & (np.isin(a, OUTLINED) | np.isin(b, OUTLINED))
        lines[:H - dy, :W - dx] |= diff; lines[dy:, dx:] |= diff
    lines = ndi.binary_dilation(lines, iterations=1)
    img[lines] *= OUTLINE_DARKNESS

    out = np.clip(img, 0, 255).astype("uint8")
    with rasterio.open(out_path, "w", driver="GTiff", width=W, height=H, count=3, dtype="uint8", crs="EPSG:27700", transform=tf, photometric="RGB", compress="deflate") as dst:
        dst.write(np.moveaxis(out, -1, 0))
    return out_path
