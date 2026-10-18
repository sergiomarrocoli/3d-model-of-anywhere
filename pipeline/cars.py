"""Paint parked cars out of the aerial imagery (optional step, after the imagery is fetched).

Photographed cars end up flat on the road when the image is draped over the terrain. The detector is a fine-tuned YOLO11n
from https://github.com/sergiomarrocoli/aerial-car-detector (`pip install -r pipeline/requirements-cars.txt`); it finds the
cars at 2x, ignores detections on building footprints, and the fill paints them out of the photo with matching grain.
"""
import os
import tempfile
from pathlib import Path

import numpy as np
import rasterio

from pipeline.bundle import _local_buildings


def _remove(rgb, features, px_per_m):
    """(cleaned rgb, number of cars). The only place that needs the detector installed, so tests replace it."""
    from cardet.api import remove_cars
    from cardet.blobs import building_mask

    mask = building_mask(features, rgb.shape[:2], px_per_m)
    cleaned, boxes = remove_cars(rgb, mask)
    return cleaned, len(boxes)


def remove_cars(imagery_path, buildings):
    """Rewrite the GeoTIFF `imagery_path` (EPSG:27700, RGB) with cars painted out; returns how many were removed.

    `buildings` is a GeoDataFrame in EPSG:27700 (may be empty): cars are not looked for on building footprints.
    """
    imagery_path = Path(imagery_path)
    with rasterio.open(imagery_path) as src:
        profile = src.profile
        rgb = np.ascontiguousarray(np.moveaxis(src.read(), 0, -1))
        origin = (src.bounds.left, src.bounds.bottom)
        px_per_m = src.width / (src.bounds.right - src.bounds.left)
    features = _local_buildings(buildings, origin)["features"] if len(buildings) else []
    cleaned, count = _remove(rgb, features, px_per_m)
    fd, tmp = tempfile.mkstemp(suffix=".tif", dir=imagery_path.parent)   # a compressed GeoTIFF is rewritten, not edited in place
    os.close(fd)
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(np.moveaxis(cleaned, -1, 0))
    os.replace(tmp, imagery_path)
    return count
