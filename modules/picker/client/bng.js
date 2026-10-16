// WGS84 <-> British National Grid (EPSG:27700) for the picker. proj4 uses a 7-parameter Helmert shift, which is good to
// about 5 m: plenty for choosing a box. The builder service re-does the conversion exactly (pyproj, OSTN15) from the
// box centre and size, so this only decides where the box is drawn.
import proj4 from 'proj4';

const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';

/** [lon, lat] -> [easting, northing] */
export const toBNG = (lon, lat) => proj4('WGS84', BNG, [lon, lat]);
/** [easting, northing] -> [lon, lat] */
export const fromBNG = (e, n) => proj4(BNG, 'WGS84', [e, n]);

// The grid's valid range. Anything outside is not in Great Britain (or is far offshore).
export const GB_EXTENT = { minE: 0, minN: 0, maxE: 700000, maxN: 1300000 };
export const insideGB = ([minE, minN, maxE, maxN]) =>
  minE >= GB_EXTENT.minE && minN >= GB_EXTENT.minN && maxE <= GB_EXTENT.maxE && maxN <= GB_EXTENT.maxN;
