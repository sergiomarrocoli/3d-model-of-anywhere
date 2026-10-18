"""Map builder: bounding box in, tile bundle out."""

# Bump when a change should make previously built bundles stale (the build service rebuilds on a mismatch).
PIPELINE_VERSION = 6  # 6: bundles carry a land cover raster
# 5: the build service removes parked cars from the imagery by default
# 4: multipolygon building relations are no longer dropped
