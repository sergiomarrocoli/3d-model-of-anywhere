"""Register the aerial photo to the OS grid and the LiDAR (spike #9).

The photo is taken off-nadir, so a point `h` metres above the ground shows up displaced: at
    footprint + ground + h * lean         (metres east, north)
where `ground` is the photo's own offset from the OS grid and `lean` is how far each metre of height pushes it.
`fit_registration` measures both from the data, `warp_imagery` undoes them.

Measuring (all by sliding things over the photo's edges, so no feature detection):
  ground  OS road centrelines: along each one's normal, where is the road's centre of mass in the photo? One shift fits all of
          them by least squares. Roads are on the ground, so the lean cannot affect them.
  lean    building outlines: slide each outline over the photo's edge strength, pool the scores of all buildings, and take
          the lean that puts the most outlines on edges when each is shifted by ground + its height * lean.
Undoing: each footprint moves as one rigid piece by its own shift (a roof is flat enough; the LiDAR is too noisy to warp
per pixel), and the ground that a leaned roof had covered is refilled smoothly from the ground around it.
"""
import shutil

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from shapely.geometry import shape as _shape

MIN_FIT_HEIGHT_M = 3.0
MIN_FIT_OUTLINE_M = 25.0
SEARCH_M, SEARCH_STEP_M = 10.0, 0.5
LEAN_E = np.arange(-0.2, 1.001, 0.05)
LEAN_N = np.arange(-0.5, 0.501, 0.05)
ROAD_HALF_WIDTH_M = 6.0
MAX_FIT_BUILDINGS = 250        # the lean is one number: a spread-out sample of this many pins it down, and the fit costs time per building
DEFAULT = {"ground": [0.0, 0.0], "lean": [0.0, 0.0]}


def _gradient(rgb, sigma_px=1.5):
    return ndi.gaussian_gradient_magnitude(rgb.astype("float64").mean(0), sigma_px)


def _grid(path):
    with rasterio.open(path) as ds:
        return ds.read().astype("float32"), ds.transform, ds.res[0], ds.profile


def _px(transform, res, x, y):
    return (transform.f - y) / res - 0.5, (x - transform.c) / res - 0.5       # row, col of pixel centres (res in metres, north-up)


def _outline_points(geom, step=0.5):
    ring = geom.exterior
    n = max(int(ring.length / step), 4)
    return np.array([ring.interpolate(i * step).coords[0] for i in range(n)])


def fit_ground(roads, imagery_path, dtm_path, dsm_path):
    """The photo's offset (east, north) from the OS grid, from road centrelines (GeoDataFrame of lines, EPSG:27700), or None if there are too few open road samples."""
    rgb, tr, res, _ = _grid(imagery_path)
    mx, mn = rgb.max(0), rgb.min(0)
    sat, val = (mx - mn) / (mx + 1e-6), mx / 255.0
    road = ndi.gaussian_filter(((sat < 0.18) & (val > 0.2) & (val < 0.75)).astype("float32"), 1.0)     # grey, mid-brightness: tarmac
    open_ground = None
    if dsm_path is not None:    # (DSM - DTM) on the LiDAR grid: roads under trees or roofs are not seen from above
        with rasterio.open(dsm_path) as a, rasterio.open(dtm_path) as b:
            nd, ntr = a.read(1, masked=True).filled(0) - b.read(1, masked=True).filled(0), a.transform
        open_ground = lambda x, y: ndi.map_coordinates(nd, [(ntr.f - y) / -ntr.e - 0.5, (x - ntr.c) / ntr.a - 0.5], order=0, mode="nearest") < 0.7
    P, N = [], []
    for ln in roads.geometry:
        for part in getattr(ln, "geoms", [ln]):
            for d in np.arange(1.0, part.length - 1.0, 1.0):
                p, q = part.interpolate(d), part.interpolate(d + 1.0)
                t = np.array([q.x - p.x, q.y - p.y]); L = np.hypot(*t)
                if L > 1e-6:
                    P.append((p.x, p.y)); N.append((-t[1] / L, t[0] / L))
    if not P:
        return None
    P, N = np.array(P), np.array(N)
    r, c = _px(tr, res, P[:, 0], P[:, 1])
    inside = (r > 0) & (c > 0) & (r < road.shape[0] - 1) & (c < road.shape[1] - 1)
    P, N = P[inside], N[inside]
    if open_ground is not None:
        keep = open_ground(P[:, 0], P[:, 1])
        P, N = P[keep], N[keep]
    if len(P) < 300:
        return None
    ts = np.arange(-ROAD_HALF_WIDTH_M, ROAD_HALF_WIDTH_M + 0.01, 0.25)
    X = P[:, 0:1] + ts[None] * N[:, 0:1]; Y = P[:, 1:2] + ts[None] * N[:, 1:2]
    rr, cc = _px(tr, res, X, Y)
    prof = ndi.map_coordinates(road, [rr.ravel(), cc.ravel()], order=1, mode="nearest").reshape(X.shape)
    prof = np.clip(prof - prof.mean(1, keepdims=True), 0, None)
    tot = prof.sum(1)
    ok = tot > 1e-6
    d = np.full(len(P), np.nan); d[ok] = (prof[ok] * ts).sum(1) / tot[ok]      # where along its normal the road is centred, per sample
    m = np.isfinite(d) & (np.abs(d) < ROAD_HALF_WIDTH_M * 0.8)
    A, y = N[m], d[m]
    s = np.linalg.lstsq(A, y, rcond=None)[0]
    for _ in range(5):                                                         # trim the outliers (parked-up verges, junction mouths)
        resid = y - A @ s; keep = np.abs(resid) < 2 * resid.std()
        s = np.linalg.lstsq(A[keep], y[keep], rcond=None)[0]
    return [float(s[0]), float(s[1])]


def fit_lean(buildings, imagery_path, ground):
    """The lean (east, north metres per metre of height) that puts the most footprint outlines on the photo's edges, given the ground offset."""
    rgb, tr, res, _ = _grid(imagery_path)
    g = _gradient(rgb)
    shifts = np.arange(-SEARCH_M, SEARCH_M + 1e-6, SEARCH_STEP_M)
    usable = [(geom, h) for geom, h in zip(buildings.geometry, buildings["height"])
              if h >= MIN_FIT_HEIGHT_M and geom.geom_type == "Polygon" and geom.exterior.length >= MIN_FIT_OUTLINE_M]
    if len(usable) > MAX_FIT_BUILDINGS:                        # every k-th, in file order: deterministic and spread over the area
        usable = [usable[int(i * len(usable) / MAX_FIT_BUILDINGS)] for i in range(MAX_FIT_BUILDINGS)]
    surfaces, heights = [], []
    for geom, h in usable:
        pts = _outline_points(geom)
        S = np.empty((len(shifts), len(shifts)), dtype="float32")
        for i, dy in enumerate(shifts):
            for j, dx in enumerate(shifts):
                r, c = _px(tr, res, pts[:, 0] + dx, pts[:, 1] + dy)
                S[i, j] = ndi.map_coordinates(g, [r, c], order=1, mode="nearest").mean()
        surfaces.append((S - S.mean()) / (S.std() + 1e-9)); heights.append(h)
    if len(surfaces) < 20:
        return None, 0
    S, H = np.array(surfaces), np.array(heights)
    k = np.arange(len(H))
    best = (-1e9, 0.0, 0.0)
    for le in LEAN_E:
        for ln in LEAN_N:
            e = ground[0] + H * le; n = ground[1] + H * ln
            col = (e - shifts[0]) / SEARCH_STEP_M; row = (n - shifts[0]) / SEARCH_STEP_M
            inside = (col >= 0) & (col <= len(shifts) - 1) & (row >= 0) & (row <= len(shifts) - 1)
            v = ndi.map_coordinates(S, [k, np.clip(row, 0, len(shifts) - 1), np.clip(col, 0, len(shifts) - 1)], order=1)
            v = np.where(inside, v, -1.0).mean()
            if v > best[0]:
                best = (v, le, ln)
    return [float(best[1]), float(best[2])], len(H)


def fit_registration(buildings, imagery_path, dtm_path, dsm_path=None, roads=None):
    """{'ground': [e, n], 'lean': [e, n], 'buildings_used': n, 'ground_from': 'roads'|'none'}. Falls back to no correction when the data cannot support a fit."""
    ground = fit_ground(roads, imagery_path, dtm_path, dsm_path) if roads is not None and len(roads) else None
    lean, n = fit_lean(buildings, imagery_path, ground or [0.0, 0.0])
    if lean is None:
        return {**DEFAULT, "buildings_used": n, "ground_from": "none"}
    return {"ground": [round(v, 2) for v in (ground or [0.0, 0.0])], "lean": [round(v, 3) for v in lean], "buildings_used": n, "ground_from": "roads" if ground else "none"}


def _push_pull(img, hole):
    """Fill `hole` pixels (True) smoothly from the valid ones around them: average valid pixels down a pyramid, then fill the holes from the coarser levels."""
    valid = (~hole).astype("float32")[None]
    levels = [(img * valid, valid)]
    while levels[-1][1].shape[1] > 4 and levels[-1][1].shape[2] > 4:
        n, v = levels[-1]; h, w = n.shape[1] // 2 * 2, n.shape[2] // 2 * 2
        levels.append((n[:, :h, :w].reshape(n.shape[0], h // 2, 2, w // 2, 2).sum((2, 4)), v[:, :h, :w].reshape(1, h // 2, 2, w // 2, 2).sum((2, 4))))
    est = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)
    for n, v in reversed(levels[:-1]):
        up = ndi.zoom(est, (1, 2, 2), order=1, mode="nearest")[:, :n.shape[1], :n.shape[2]]
        if up.shape[1] < n.shape[1] or up.shape[2] < n.shape[2]:
            up = np.pad(up, ((0, 0), (0, n.shape[1] - up.shape[1]), (0, n.shape[2] - up.shape[2])), mode="edge")
        est = np.where(v > 0.5, n / np.maximum(v, 1e-6), up)
    return est


def warp_imagery(imagery_path, buildings, ground, lean, out_path):
    """Write the photo with every footprint moved back to where it really is. Returns the share of pixels refilled."""
    if not any(ground) and not any(lean):          # nothing was measured: the photo stays as it is
        shutil.copyfile(imagery_path, out_path)
        return 0.0
    rgb, tr, res, profile = _grid(imagery_path)
    ch, h, w = rgb.shape
    H = Image.new("F", (w, h), 0.0); draw = ImageDraw.Draw(H)
    for geom, ht in sorted(zip(buildings.geometry, buildings["height"]), key=lambda t: t[1]):      # tallest last wins where footprints overlap
        if geom.geom_type != "Polygon":
            continue
        draw.polygon([((x - tr.c) / res, (tr.f - y) / res) for x, y, *_ in geom.exterior.coords], fill=float(ht))
    H = np.array(H, dtype="float32")
    yy, xx = np.mgrid[0:h, 0:w].astype("float32")
    de = (ground[0] + H * lean[0]) / res; dn = (ground[1] + H * lean[1]) / res
    # output pixel at a roof reads the photo where the roof is shown; at the ground, where the ground is shown
    out = np.stack([ndi.map_coordinates(rgb[c], [yy - dn, xx + de], order=1, mode="nearest") for c in range(ch)])
    # the ground a leaned roof landed on in the photo: forward-splat every roof pixel to where it is shown, then fill the ground that reads those
    ty, tx = np.nonzero(H[::2, ::2] > 0); ty, tx = ty * 2, tx * 2
    ly = np.round(ty - (ground[1] + H[ty, tx] * lean[1]) / res).astype(int); lx = np.round(tx + (ground[0] + H[ty, tx] * lean[0]) / res).astype(int)
    ok = (lx >= 0) & (lx < w) & (ly >= 0) & (ly < h)
    cover = np.zeros((h, w), bool); cover[ly[ok], lx[ok]] = True
    cover = ndi.binary_closing(cover, iterations=2)
    gn, ge = int(round(ground[1] / res)), int(round(ground[0] / res))
    hole = (H <= 0) & np.roll(cover, (gn, -ge), (0, 1))      # ground output pixels that read a photo pixel a roof was shown on
    hole = ndi.binary_dilation(hole, iterations=6) & (H <= 0)
    if hole.any():
        fill = _push_pull(out, hole)
        grain = np.roll(np.roll(out - ndi.gaussian_filter(out, (0, 2, 2)), 40, 1), 70, 2)       # the ground's own texture, so the patch is not a flat smear
        out = np.where(hole[None], fill + grain, out)
    profile.update(dtype="uint8")
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(np.clip(out, 0, 255).astype("uint8"))
    return float(hole.mean())
