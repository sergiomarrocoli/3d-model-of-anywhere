"""Map builder: bounding box in, tile bundle out."""

# Bump when a change should make previously built bundles stale (the build service rebuilds on a mismatch).
PIPELINE_VERSION = 4  # 4: multipolygon building relations are no longer dropped
