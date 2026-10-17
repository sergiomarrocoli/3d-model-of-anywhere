// Clean roofs from a noisy LiDAR surface, with no three.js in it. The raw DSM has tree overhang, chimneys, dormers and a 1-2 m
// cell, so draping it on a building gives smoothed lumps. Instead each building gets the simple roof that best matches its
// DSM: flat, shed (one slope), gable (a straight ridge) or hip (slopes on all sides). The eaves, the peak and the ridge position
// are read from the data; the shape itself is exact, so the roof is made of flat faces with straight ridges and eaves.
// Local metres (x east, y north); heights are absolute elevations.

export const MIN_RISE_M = 1.2;         // less than this between eaves and peak and the roof is flat
export const MAX_PITCH_TAN = 1.2;      // the steepest roof: rise over run (about 50 degrees)
export const MAX_ERROR_M = 3;          // if the best pitched roof is still this far from the DSM on average, say nothing: the caller keeps the raw DSM
export const MAX_FLAT_ERROR_M = 2;     // a flat roof has to fit more tightly: on a building with real height variation (two levels, an odd roof) "flat" is just wrong
export const MAX_SHED_ERROR_M = 1;      // a single slope has to be a tight fit: a plane through a step between two levels is not a roof
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
 * @returns null when there is too little data to say anything, or no simple roof matches it (MAX_ERROR_M); else
 *   { kind: 'flat'|'shed'|'gable'|'hip', z(x, y), creases: [side(x, y)], maxLen, eave, peak, error }
 *   `creases` are signed-distance functions of the straight lines the roof bends along (a gable's ridge): geometry should have a
 *   vertex wherever an edge crosses one, and then the faces are exactly flat. `maxLen` is how fine the faces must be (Infinity
 *   when the roof is exactly flat-faced and the creases are enough; a hip bends along diagonals, so it needs a fine grid).
 */
export function fitRoof(rings, height, distance) {
  const sampled = sampleFootprint(rings, height, distance);
  return sampled ? fitSamples(sampled.pts, sampled.frame, distance) : null;
}

/** The DSM sampled on a grid inside the footprint (clear of the edge), and the building's frame: its dominant direction and its extent in it. Null if too few samples. */
export function sampleFootprint(rings, height, distance) {
  const outer = rings[0];
  const th = dominantAngle(outer), ca = Math.cos(th), sa = Math.sin(th);
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity, x0 = 0, y0 = 0;
  for (const [x, y] of outer) { const a = x * ca + y * sa, b = -x * sa + y * ca; amin = Math.min(amin, a); amax = Math.max(amax, a); bmin = Math.min(bmin, b); bmax = Math.max(bmax, b); x0 += x / outer.length; y0 += y / outer.length; }
  const step = Math.max(1, Math.sqrt(((amax - amin) * (bmax - bmin)) / MAX_SAMPLES)), pts = [];
  for (let a = amin + step / 2; a < amax; a += step) for (let b = bmin + step / 2; b < bmax; b += step) {
    const x = a * ca - b * sa, y = a * sa + b * ca;
    if (inside(rings, x, y) && distance(x, y) >= SAMPLE_INSET_M) pts.push([x, y, height(x, y)]);
  }
  return pts.length < MIN_SAMPLES ? null : { pts, frame: { ca, sa, amin, amax, bmin, bmax, x0, y0 } };
}

/**
 * The best simple roof for a set of samples in a frame (see sampleFootprint; for a zone the frame's extent is the zone's). `allowHip` lets a hip be
 * considered (it needs the distance to the footprint edge, so only for a whole building); `gate` false returns the best fit even if it is a poor one
 * (to decide whether to split), with its `error`.
 */
export function fitSamples(pts, frame, distance, { allowHip = true, gate = true } = {}) {
  const { ca, sa, amin, amax, bmin, bmax, x0, y0 } = frame;
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
  const hp = allowHip ? profile(gHip) : { rise: 0 };
  if (hp.rise >= MIN_RISE_M) { const z = (x, y) => hp.eave + hp.rise * gHip(x, y); options.push({ kind: 'hip', z, creases: [], maxLen: 1, eave: hp.eave, peak: hp.eave + hp.rise, error: mae(z) }); }
  const ok = (r) => (!gate || r.error <= (r.kind === 'flat' ? MAX_FLAT_ERROR_M : MAX_ERROR_M) ? r : null);
  if (!options.length && percentile(zs, 0.9) - percentile(zs, 0.1) < MIN_RISE_M) return ok({ ...flat, error: flatErr });
  const plane = fitPlane(pts, x0, y0), lo = percentile(zs, 0.05), hi = Math.min(percentile(zs, 0.95), lo + MAX_PITCH_TAN * 2 * hw);   // a shed's run is the whole width
  if (plane) {                                                       // one slope: kept only if it clearly beats the ridge shapes
    const z = (x, y) => Math.max(lo, Math.min(hi, plane[0] + plane[1] * (x - x0) + plane[2] * (y - y0))), error = mae(z);
    if (hi - lo >= MIN_RISE_M && error <= MAX_SHED_ERROR_M && error < 0.6 * Math.min(flatErr, ...options.map((o) => o.error))) options.push({ kind: 'shed', z, creases: [], maxLen: Infinity, eave: lo, peak: hi, error });
  }
  if (!options.length) return ok({ ...flat, error: flatErr });
  const best = options.reduce((a, b) => (b.error < a.error ? b : a));
  return ok(best.error + 0.15 < flatErr ? best : { ...flat, error: flatErr });      // a pitched roof has to be clearly better than flat
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Zones: a building no single roof fits (a tall block with a low annex, a main roof with a flat wing) is cut along straight lines in its own
// axes into zones that each get their own simple roof, with a vertical step between them. The cuts are found like a regression tree: try the cut
// (across either axis, at any position) that best separates the DSM into two levels; keep it if the two halves fit clearly better than the whole;
// and carry on into each half while it still fits badly.

export const SPLIT_ERROR_M = 0.8;       // a zone that fits this well is left alone
export const SPLIT_GAIN = 0.7;          // a cut is kept only if the two halves' error is at most this fraction of the whole's
export const MIN_ZONE_WIDTH_M = 3;      // zones are at least this wide...
export const MIN_ZONE_SAMPLES = 10;     // ...and hold at least this many samples
export const MAX_ZONE_DEPTH = 3;        // cuts of cuts of cuts: at most 8 zones

/** The coordinate of (x, y) along a frame axis: 'a' is the building's dominant direction, 'b' across it. */
const coordOf = (frame, axis, x, y) => (axis === 'a' ? x * frame.ca + y * frame.sa : -x * frame.sa + y * frame.ca);

/** The best cut of these samples across `axis`: { axis, c, sse } minimising the squared error of two flat levels, or null if none is allowed. */
function bestCut(pts, frame, bounds) {
  let best = null;
  for (const axis of ['a', 'b']) {
    const lo = axis === 'a' ? bounds.amin : bounds.bmin, hi = axis === 'a' ? bounds.amax : bounds.bmax;
    const order = pts.map((p) => [coordOf(frame, axis, p[0], p[1]), p[2]]).sort((p, q) => p[0] - q[0]), n = order.length;
    const sum = [0], sq = [0];
    for (const [, z] of order) { sum.push(sum.at(-1) + z); sq.push(sq.at(-1) + z * z); }
    for (let k = MIN_ZONE_SAMPLES; k <= n - MIN_ZONE_SAMPLES; k++) {
      if (order[k][0] - order[k - 1][0] < 1e-9) continue;
      const c = (order[k - 1][0] + order[k][0]) / 2;
      if (c - lo < MIN_ZONE_WIDTH_M || hi - c < MIN_ZONE_WIDTH_M) continue;
      const sse = (sq[k] - (sum[k] * sum[k]) / k) + (sq[n] - sq[k] - ((sum[n] - sum[k]) ** 2) / (n - k));
      if (!best || sse < best.sse) best = { axis, c, sse };
    }
  }
  return best;
}

/**
 * Refine a cut's position: the samples only say where it is to within their spacing, so look at the DSM itself, 0.1 m at a time, either side, and
 * put the cut in the middle of where the level changes fastest across it (the average over the zone's samples along the cut).
 */
function refineCut(cut, pts, frame, height, reach) {
  const other = cut.axis === 'a' ? 'b' : 'a', at = (t, o) => (cut.axis === 'a' ? [t * frame.ca - o * frame.sa, t * frame.sa + o * frame.ca] : [o * frame.ca - t * frame.sa, o * frame.sa + t * frame.ca]);
  const lines = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 40)) === 0).map((p) => coordOf(frame, other, p[0], p[1])), cands = [];
  for (let t = cut.c - reach; t <= cut.c + reach + 1e-9; t += 0.1) {
    let g = 0; for (const o of lines) { const [x0, y0] = at(t - 0.25, o), [x1, y1] = at(t + 0.25, o); g += Math.abs(height(x1, y1) - height(x0, y0)); }
    cands.push([t, g / lines.length]);
  }
  const top = Math.max(...cands.map((c) => c[1]));
  if (top < 1e-6) return cut;
  const near = cands.filter((c) => c[1] >= 0.97 * top);
  return { ...cut, c: near.reduce((s, c) => s + c[0], 0) / near.length };
}

/**
 * The roof of a whole building as zones. Returns null if there is too little data, or some zone fits no simple roof (the caller then keeps the raw DSM).
 * Otherwise { zones: [{ model, contains(x, y), id }], lines: [side(x, y)], creases, maxLen, error, zoneAt(x, y) }:
 *   - `zones`: each with its roof model (as fitRoof) and a test for which zone a point is in;
 *   - `lines`: the cuts between zones, as signed-distance functions: geometry has a vertex wherever an edge crosses one, and a vertical step
 *     face goes along each edge on a cut between two zones;
 *   - `creases`: the cuts plus every zone's own creases (a gable's ridge), all to be split on; `maxLen` as for fitRoof.
 * A building that fits well as one zone has one zone and no lines (and then it may be a hip).
 * `groundZ`: a flat zone at or below this height is bare ground (a strip of car park or lawn the outline takes in), flagged `ground`: the caller
 * builds no roof or outline wall there, which clips the footprint to the real building. If every zone is ground none is flagged (a low shed).
 */
export function fitBuildingRoof(rings, height, distance, { groundZ = -Infinity } = {}) {
  const sampled = sampleFootprint(rings, height, distance);
  if (!sampled) return null;
  const { pts, frame } = sampled, spacing = Math.max(1, Math.sqrt(((frame.amax - frame.amin) * (frame.bmax - frame.bmin)) / MAX_SAMPLES));
  const lines = [];
  const grow = (zonePts, bounds, constraints, depth) => {
    const model = fitSamples(zonePts, { ...frame, ...bounds }, distance, { allowHip: depth === 0, gate: false });
    const leaf = { leaf: true, model, constraints, pts: zonePts };
    if (!model || depth >= MAX_ZONE_DEPTH || model.error <= SPLIT_ERROR_M || zonePts.length < 2 * MIN_ZONE_SAMPLES) return leaf;
    const rough = bestCut(zonePts, frame, bounds);
    if (!rough) return leaf;
    const cut = refineCut(rough, zonePts, frame, height, spacing);
    const lowSide = zonePts.filter((p) => coordOf(frame, cut.axis, p[0], p[1]) < cut.c), highSide = zonePts.filter((p) => coordOf(frame, cut.axis, p[0], p[1]) >= cut.c);
    const loB = { ...bounds, [cut.axis === 'a' ? 'amax' : 'bmax']: cut.c }, hiB = { ...bounds, [cut.axis === 'a' ? 'amin' : 'bmin']: cut.c };
    const lo = grow(lowSide, loB, [...constraints, { axis: cut.axis, c: cut.c, sign: -1 }], depth + 1), hi = grow(highSide, hiB, [...constraints, { axis: cut.axis, c: cut.c, sign: 1 }], depth + 1);
    const leaves = (t) => (t.leaf ? [t] : [...leaves(t.lo), ...leaves(t.hi)]);
    const parts = [...leaves(lo), ...leaves(hi)];
    if (parts.some((l) => !l.model)) return leaf;
    const err = parts.reduce((s, l) => s + l.model.error * l.pts.length, 0) / zonePts.length;
    return err <= SPLIT_GAIN * model.error ? { leaf: false, cut, lo, hi } : leaf;
  };
  const root = grow(pts, { amin: frame.amin, amax: frame.amax, bmin: frame.bmin, bmax: frame.bmax }, [], 0);
  const collect = (t) => (t.leaf ? [t] : [...collect(t.lo), ...collect(t.hi)]);
  const leaves = collect(root);
  if (leaves.some((l) => !l.model)) return null;
  const passes = (m) => m.error <= (m.kind === 'flat' ? MAX_FLAT_ERROR_M : MAX_ERROR_M);
  if (leaves.some((l) => !passes(l.model))) return null;
  const cutsOf = (t) => (t.leaf ? [] : [t.cut, ...cutsOf(t.lo), ...cutsOf(t.hi)]);
  const sides = cutsOf(root).map((c) => (x, y) => coordOf(frame, c.axis, x, y) - c.c);
  const zones = leaves.map((l, id) => ({
    id, model: l.model, error: l.model.error,
    contains: (x, y) => l.constraints.every((c) => (coordOf(frame, c.axis, x, y) - c.c) * c.sign >= 0),
  }));
  const isGround = (m) => m.kind === 'flat' && m.z(0, 0) <= groundZ;
  if (!zones.every((z) => isGround(z.model))) for (const z of zones) z.ground = isGround(z.model);
  const total = leaves.reduce((s, l) => s + l.pts.length, 0), error = leaves.reduce((s, l) => s + l.model.error * l.pts.length, 0) / total;
  return {
    zones, lines: sides, error,
    creases: [...sides, ...zones.flatMap((z) => z.model.creases)],
    maxLen: Math.min(...zones.map((z) => z.model.maxLen)),
    zoneAt: (x, y) => zones.find((z) => z.contains(x, y)) ?? zones[0],
  };
}
