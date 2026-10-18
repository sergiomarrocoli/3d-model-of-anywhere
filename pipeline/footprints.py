"""Fill gaps in the OSM footprints from OS Open Map Local (spike #9).

OSM is patchy: whole housing estates can be unmapped while the LiDAR plainly shows the buildings. Open Map Local
has a footprint for most of them, but no tags and a few false ones (yards, sheds the LiDAR cannot see). So its
buildings are added only where OSM has none, and kept only if the LiDAR then confirms something tall there.

Usage in the pipeline: `merged = add_missing(osm, oml)`, assign heights, then `drop_unconfirmed(merged)`.
"""
import geopandas as gpd

MIN_AREA_M2 = 15.0            # Open Map Local also has party-wall and gap fragments: an addition must be a plausible building (a garage is about 15 m2)
MIN_WIDTH_M = 2.0             # mean width, 2 x area / perimeter
MAX_OVERLAP = 0.25            # an Open Map Local building more than this covered by OSM buildings is the same building, not a new one
OML_PREFIX = "oml/"


def add_missing(osm, oml, max_overlap=MAX_OVERLAP, min_area=MIN_AREA_M2, min_width=MIN_WIDTH_M):
    """`osm` plus the buildings of `oml` that OSM does not already have (both EPSG:27700 GeoDataFrames), leaving out slivers."""
    if oml is None or oml.empty:
        return osm
    oml = oml[(oml.area >= min_area) & (2 * oml.area / oml.length >= min_width)]
    if oml.empty:
        return osm
    if osm.empty:
        return oml.copy()
    covered = osm.geometry.union_all() if hasattr(osm.geometry, "union_all") else osm.geometry.unary_union
    share = oml.geometry.apply(lambda g: g.intersection(covered).area / g.area if g.area > 0 else 1.0)
    new = oml[share <= max_overlap]
    if new.empty:
        return osm
    return gpd.GeoDataFrame(gpd.pd.concat([osm, new], ignore_index=True), geometry="geometry", crs=osm.crs)


def drop_unconfirmed(buildings):
    """Remove the Open Map Local additions whose height did not come from LiDAR (the LiDAR sees nothing tall there)."""
    from_oml = buildings["osm_id"].astype(str).str.startswith(OML_PREFIX)
    return buildings[~from_oml | (buildings["height_source"] == "lidar")].reset_index(drop=True)
