"""Check that DTM, buildings and imagery share one grid, and render an overlay for eyeballing.

Usage: python3 -m pipeline.check_alignment [--dtm data/dtm.tif] [--imagery data/imagery.tif]
           [--buildings data/buildings.geojson] [--out data/alignment.png]
"""
import argparse

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from matplotlib.colors import LightSource


def check(dtm_path, img_path, bld_path, out):
    with rasterio.open(dtm_path) as dtm, rasterio.open(img_path) as img:
        problems = []
        if str(dtm.crs) != str(img.crs) or str(dtm.crs) != "EPSG:27700":
            problems.append(f"CRS mismatch: dtm={dtm.crs} imagery={img.crs}")
        if not np.allclose(tuple(dtm.bounds), tuple(img.bounds), atol=1e-6):
            problems.append(f"bounds differ: dtm={tuple(dtm.bounds)} imagery={tuple(img.bounds)}")
        bld = gpd.read_file(bld_path)
        if str(bld.crs) != "EPSG:27700":
            problems.append(f"buildings CRS {bld.crs}")
        minx, miny, maxx, maxy = bld.total_bounds
        b = dtm.bounds
        if minx < b.left - 1e-6 or miny < b.bottom - 1e-6 or maxx > b.right + 1e-6 or maxy > b.top + 1e-6:
            problems.append("buildings extend outside the DTM bounds")

        extent = (b.left, b.right, b.bottom, b.top)
        rgb = np.moveaxis(img.read(), 0, -1)
        z = dtm.read(1, masked=True).filled(np.nan)
        hs = LightSource(azdeg=315, altdeg=45).hillshade(np.nan_to_num(z), vert_exag=3, dx=dtm.res[0], dy=dtm.res[1])

        fig, axes = plt.subplots(1, 3, figsize=(24, 8.2))
        axes[0].imshow(rgb, extent=extent); axes[0].set_title("Imagery + building outlines")
        axes[1].imshow(hs, extent=extent, cmap="gray"); axes[1].set_title("DTM hillshade + building outlines")
        axes[2].imshow(rgb, extent=extent); axes[2].imshow(hs, extent=extent, cmap="gray", alpha=0.45)
        axes[2].set_title("All three")
        for ax in axes:
            bld.boundary.plot(ax=ax, color="red" if ax is not axes[1] else "cyan", linewidth=0.6)
            ax.set_xlim(b.left, b.right); ax.set_ylim(b.bottom, b.top)
            ax.set_xlabel("Easting (m)"); ax.set_ylabel("Northing (m)")
        fig.tight_layout()
        fig.savefig(out, dpi=100)
        return problems


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dtm", default="data/dtm.tif")
    ap.add_argument("--imagery", default="data/imagery.tif")
    ap.add_argument("--buildings", default="data/buildings.geojson")
    ap.add_argument("--out", default="data/alignment.png")
    a = ap.parse_args()
    issues = check(a.dtm, a.imagery, a.buildings, a.out)
    print("Grid checks:", "OK" if not issues else issues)
    print("Overlay written to", a.out)
