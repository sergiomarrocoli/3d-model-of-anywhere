// Clean roofs from a noisy LiDAR surface, with no three.js in it. The raw DSM has tree overhang, chimneys, dormers and a 1-2 m
// cell, so draping it on a building gives smoothed lumps. Instead each building gets the simple roof that best matches its
// DSM: flat, shed (one slope), gable (a straight ridge) or hip (slopes on all sides). The eaves, the peak and the ridge position
// are read from the data; the shape itself is exact, so the roof is made of flat faces with straight ridges and eaves.
// Local metres (x east, y north); heights are absolute elevations.

export const MIN_RISE_M = 1.2;         // less than this between eaves and peak and the roof is flat
export const MAX_PITCH_TAN = 1.2;      // the steepest roof: rise over run (about 50 degrees)
export const MIN_SAMPLES = 6;
const MAX_SAMPLES = 300;
const SAMPLE_INSET_M = 0.5;            // samples this close to the footprint edge are skipped: they mix in the ground and neighbours

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/** Is (x, y) inside the polygon with holes (even-odd)? */
export function inside(rings, x, y) {
  let c = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** The direction (radians) most of the outline runs in, as a right angle's worth: edges weighted by length, mod 90 degrees. */
export function dominantAngle(ring) {
  let sx = 0, sy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length], len = Math.hypot(bx - ax, by - ay), a = Math.atan2(by - ay, bx - ax);
    sx += len * Math.cos(4 * a); sy += len * Math.sin(4 * a);
  }
  return Math.atan2(sy, sx) / 4;
}

/** Least squares plane z = c0 + c1 (x - x0) + c2 (y - y0) through the samples (3x3 normal equations). Null if they are in a line. */
function fitPlane(pts, x0, y0) {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0; const n = pts.length;
  for (const [px, py, z] of pts) { const x = px - x0, y = py - y0; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += z; sxz += x * z; syz += y * z; }
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const A = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy], d = det(A);
  if (Math.abs(d) < 1e-9) return null;
  const col = (k, v) => A.map((a, i) => (i % 3 === k ? v[Math.floor(i / 3)] : a));
  const b = [sz, sxz, syz];
  return [det(col(0, b)) / d, det(col(1, b)) / d, det(col(2, b)) / d];
}

/**
 * Fit the best simple roof to a building.
 * @param rings    normalised footprint rings (outer first), local metres
 * @param height   (x, y) -> DSM elevation
 * @param distance (x, y) -> distance from (x, y) to the nearest footprint edge
 * @returns null when there is too little data to say anything; else
 *   { kind: 'flat'|'shed'|'gable'|'hip', z(x, y), creases: [side(x, y)], maxLen, eave, peak, error }
 *   `creases` are signed-distance functions of the straight lines the roof bends along (a gable's ridge): geometry should have a
 *   vertex wherever an edge crosses one, and then the faces are exactly flat. `maxLen` is how fine the faces must be (Infinity
 *   when the roof is exactly flat-faced and the creases are enough; a hip bends along diagonals, so it needs a fine grid).
 */
export function fitRoof(rings, height, distance) {
  const outer = rings[0];
  const th = dominantAngle(outer), ca = Math.cos(th), sa = Math.sin(th);
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity, x0 = 0, y0 = 0;
  for (const [x, y] of outer) { const a = x * ca + y * sa, b = -x * sa + y * ca; amin = Math.min(amin, a); amax = Math.max(amax, a); bmin = Math.min(bmin, b); bmax = Math.max(bmax, b); x0 += x / outer.length; y0 += y / outer.length; }
  const step = Math.max(1, Math.sqrt(((amax - amin) * (bmax - bmin)) / MAX_SAMPLES)), pts = [];
  for (let a = amin + step / 2; a < amax; a += step) for (let b = bmin + step / 2; b < bmax; b += step) {
    const x = a * ca - b * sa, y = a * sa + b * ca;
    if (inside(rings, x, y) && distance(x, y) >= SAMPLE_INSET_M) pts.push([x, y, height(x, y)]);
  }
  if (pts.length < MIN_SAMPLES) return null;
  const zs = pts.map((p) => p[2]).sort((p, q) => p - q), med = percentile(zs, 0.5);
  const mae = (f) => pts.reduce((s, [x, y, z]) => s + Math.abs(f(x, y) - z), 0) / pts.length;

  // the ridge runs along the longer side of the footprint, so the roof slopes across the shorter one
  const alongA = amax - amin >= bmax - bmin;
  const cross = alongA ? (x, y) => -x * sa + y * ca : (x, y) => x * ca + y * sa;     // the coordinate that runs across the roof
  const cmin = alongA ? bmin : amin, cmax = alongA ? bmax : amax, wm = (cmin + cmax) / 2, hw = Math.max((cmax - cmin) / 2, 1e-6);

  // A ridge shape is eave + rise * g(x, y), g running 0 at the eaves to 1 on the ridge. The eave and rise come from a regression of the
  // data on g, dropping the outliers (chimneys, trees) twice, so a peak that only a thin strip of the roof reaches is still found.
  const profile = (g) => {
    let use = pts.map((p, i) => [g(p[0], p[1]), p[2], i]), e = percentile(zs, 0.1), rise = 0;
    for (let pass = 0; pass < 3; pass++) {
      const n = use.length; let sg = 0, sz = 0, sgg = 0, sgz = 0;
      for (const [gv, z] of use) { sg += gv; sz += z; sgg += gv * gv; sgz += gv * z; }
      const den = n * sgg - sg * sg;
      rise = den > 1e-9 ? (n * sgz - sg * sz) / den : 0; e = (sz - rise * sg) / n;
      const limit = Math.max(0.6, 2 * Math.sqrt(use.reduce((a, [gv, z]) => a + (e + rise * gv - z) ** 2, 0) / n));
      const kept = use.filter(([gv, z]) => Math.abs(e + rise * gv - z) <= limit);
      if (kept.length < MIN_SAMPLES || kept.length === use.length) break;
      use = kept;
    }
    return { eave: e, rise: Math.min(Math.max(rise, 0), MAX_PITCH_TAN * hw) };
  };

  const flat = { kind: 'flat', z: () => med, creases: [], maxLen: Infinity, eave: med, peak: med };
  const flatErr = mae(flat.z);
  const gGable = (x, y) => 1 - Math.min(1, Math.abs(cross(x, y) - wm) / hw), gHip = (x, y) => Math.min(1, distance(x, y) / hw);
  const options = [];
  const gp = profile(gGable);
  if (gp.rise >= MIN_RISE_M) { const z = (x, y) => gp.eave + gp.rise * gGable(x, y); options.push({ kind: 'gable', z, creases: [(x, y) => cross(x, y) - wm], maxLen: Infinity, eave: gp.eave, peak: gp.eave + gp.rise, error: mae(z) }); }
  const hp = profile(gHip);
  if (hp.rise >= MIN_RISE_M) { const z = (x, y) => hp.eave + hp.rise * gHip(x, y); options.push({ kind: 'hip', z, creases: [], maxLen: 1, eave: hp.eave, peak: hp.eave + hp.rise, error: mae(z) }); }
  if (!options.length && percentile(zs, 0.9) - percentile(zs, 0.1) < MIN_RISE_M) return { ...flat, error: flatErr };
  const plane = fitPlane(pts, x0, y0), lo = percentile(zs, 0.05), hi = Math.min(percentile(zs, 0.95), lo + MAX_PITCH_TAN * 2 * hw);   // a shed's run is the whole width
  if (plane) {                                                       // one slope: kept only if it clearly beats the ridge shapes
    const z = (x, y) => Math.max(lo, Math.min(hi, plane[0] + plane[1] * (x - x0) + plane[2] * (y - y0))), error = mae(z);
    if (hi - lo >= MIN_RISE_M && error < 0.6 * Math.min(flatErr, ...options.map((o) => o.error))) options.push({ kind: 'shed', z, creases: [], maxLen: Infinity, eave: lo, peak: hi, error });
  }
  if (!options.length) return { ...flat, error: flatErr };
  const best = options.reduce((a, b) => (b.error < a.error ? b : a));
  return best.error + 0.15 < flatErr ? best : { ...flat, error: flatErr };      // a pitched roof has to be clearly better than flat
}
