"""Clean building footprints: fix invalid geometry, drop slivers, simplify slightly (PLAN §3.4).

Usage: python3 -m pipeline.clean --in data/buildings.geojson --out data/buildings_clean.geojson
"""
import argparse

import geopandas as gpd

MIN_AREA_M2 = 5.0
SIMPLIFY_TOLERANCE_M = 0.3


def clean_buildings(gdf, min_area=MIN_AREA_M2, tolerance=SIMPLIFY_TOLERANCE_M):
    """Return a cleaned copy of `gdf` (polygons in a metre-based CRS)."""
    out = gdf.copy()
    out["geometry"] = out.geometry.make_valid()
    out = out[~out.geometry.is_empty & out.geometry.notna()].explode(index_parts=False)
    out = out[out.geom_type == "Polygon"]  # make_valid can emit lines/points for degenerate input
    out = out[out.area >= min_area]
    out["geometry"] = out.geometry.simplify(tolerance, preserve_topology=True)
    out["geometry"] = out.geometry.make_valid()
    out = out[~out.geometry.is_empty & (out.geom_type == "Polygon") & (out.area >= min_area)]
    return out.reset_index(drop=True)


def stats(before, after):
    return {
        "before": len(before),
        "after": len(after),
        "dropped": len(before) - len(after),
        "vertices_before": int(before.geometry.get_coordinates().shape[0]),
        "vertices_after": int(after.geometry.get_coordinates().shape[0]),
        "all_valid": bool(after.geometry.is_valid.all()),
        "min_area_m2": round(float(after.area.min()), 2) if len(after) else None,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default="data/buildings.geojson")
    ap.add_argument("--out", default="data/buildings_clean.geojson")
    ap.add_argument("--min-area", type=float, default=MIN_AREA_M2)
    ap.add_argument("--tolerance", type=float, default=SIMPLIFY_TOLERANCE_M)
    a = ap.parse_args()
    src = gpd.read_file(a.src)
    dst = clean_buildings(src, a.min_area, a.tolerance)
    dst.to_file(a.out, driver="GeoJSON")
    print(stats(src, dst))
