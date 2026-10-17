import * as THREE from 'three';
import { toWorld } from './coords.js';
import { sampleHeight } from './heightmap.js';
import { facadeLook } from './facade.js';
import { fitBuildingRoof, inside } from './roof.js';

export const DEFAULT_HEIGHT_M = 6;
// Walls are coloured by the imagery just inside the footprint edge: sampling exactly on the edge often hits the
// ground or a shadow, because aerial photos lean tall buildings away from their footprints.
export const WALL_SAMPLE_INSET_M = 0.75;
// Walls copy the imagery at 75% of its brightness (tuned by eye with the owner: 50% and 25% were too dark), so they
// read as shaded verticals next to the roofs. Set as an sRGB grey, so it scales the displayed pixel values.
export const WALL_BRIGHTNESS = 0.75;

// Pitched roofs (when the bundle has a surfacemap): each building gets the simple roof (flat, shed, gable or hip, see roof.js) that best
// matches the LiDAR DSM, with vertical walls up to the eaves and gable ends. Where there is too little data the roof follows the raw DSM.
export const ROOF_GRID_M = 2;          // roofs that follow the raw DSM are refined until no edge is longer than this
export const ROOF_INSET_M = 1.5;       // within this distance of the footprint edge the DSM is read on this inset line, so the roof edge is crisp (walls drop vertically from it) and not smeared with the ground or a neighbour
export const MIN_ROOF_ABOVE_BASE_M = 2;
export const GROUND_ABOVE_BASE_M = 1.5;   // a flat zone of the roof fit no higher than this above the building's base is bare ground, not roof: it is left out
// An outline is often a metre or three bigger than the roof (a strip of car park or lawn inside it), so the DSM right at the edge is ground.
// The roof height at an edge is therefore read further in, along the inward normal at these depths, as a high percentile (the roof, not the rim),
// and nothing within RIM_DEPTH_M of the edge may dip below it: the wall goes straight up to the eaves instead of the roof sloping down to the ground.
export const EAVE_DEPTHS_M = [1, 2, 3, 4];
export const EAVE_SPREAD_M = [-3, -1.5, 0, 1.5, 3];   // ...pooled with the same depths at these offsets along the edge, so neighbouring wall pieces agree and the wall top does not zig-zag
export const EAVE_PERCENTILE = 0.75;
export const RIM_DEPTH_M = 4.5;
const MAX_REFINE_PASSES = 10;

// Wall texture: each wall is its average colour (8 taps spread along its footprint edge in the imagery) with a subtle
// grain around it. The grain has two parts, both from smooth noise addressed in metres along and up the wall, so
// it is continuous across the pieces a wall is split into: (1) a pull toward the colour found at a random place
// along the edge, so walls with several colours get a hint of each, and (2) a gentle brightness mottle.
export const WALL_PATCH_M = 0.6;     // size of the larger grain features
export const WALL_VARIATION = 0.3;   // 0 = flat average colour, 1 = fully the randomly picked colour
export const WALL_MOTTLE = 0.12;     // +/- brightness variation

// The facade, drawn over the wall's patchwork colour: material (brick, stone, render, cladding: from the tag, else guessed from the colour of the imagery),
// plinth, a grid of windows per storey with sills and frames, doors, shopfronts with a fascia, and a coping line along the top. Everything is addressed in
// metres along and up the wall, so it runs on across the pieces a wall is split into, and fades out when it is too fine for the pixels (fwidth).
const FACADE_GLSL = `
        float fAlong = vWallDetail.x, fV = vWallDetail.y - vFacade.x, fTop = vFacade.y - vFacade.x, fL = vFacade.z, fFloor = max(vFacade.w, 1.0);
        float fMat = vLook.x, fWin = vLook.y, fSeed = vLook.z, fShop = vLook.w;
        float px = max(fwidth(fV), 1e-4);                                           // metres per pixel up the wall: patterns finer than this fade away
        float fine = 1.0 - clamp(px / 0.12, 0.0, 1.0), coarse = 1.0 - clamp(px / 0.6, 0.0, 1.0);
        float luma = dot(wallCol, vec3(0.3, 0.59, 0.11));
        float pick = fract(fSeed * 23.0);                                              // when nothing is tagged: red-ish walls are brick, pale ones render, the rest a mix
        if (fMat < -0.5) fMat = (wallCol.r > wallCol.g * 1.1 && wallCol.r > wallCol.b * 1.18) ? 0.0 : (luma > 0.5 ? 2.0 : (pick < 0.3 ? 0.0 : (pick < 0.65 ? 2.0 : 1.0)));
        float pal = fract(fSeed * 5.0);
        vec3 renderCol = pal < 0.2 ? vec3(0.9, 0.86, 0.72) : pal < 0.4 ? vec3(0.9, 0.9, 0.88) : pal < 0.6 ? vec3(0.88, 0.8, 0.55) : pal < 0.8 ? vec3(0.86, 0.7, 0.66) : vec3(0.7, 0.76, 0.8);
        vec3 matCol = fMat < 0.5 ? mix(vec3(0.64, 0.3, 0.22), vec3(0.74, 0.42, 0.3), fract(fSeed * 7.0))
                    : fMat < 1.5 ? mix(vec3(0.68, 0.59, 0.42), vec3(0.78, 0.69, 0.5), fract(fSeed * 5.0))
                    : fMat < 2.5 ? renderCol : vec3(0.5, 0.53, 0.56);
        vec3 albedo = mix(wallCol, pow(matCol, vec3(2.2)) * (0.95 + 0.3 * luma), 0.88);
        albedo = mix(albedo, pow(vTint.rgb, vec3(2.2)), vTint.a * 0.85);
        if (fMat < 0.5) {                                                           // brick: courses 0.22 m, bricks 0.55 m, each a little different
          float c = fV / 0.22, row = floor(c), bx = fAlong / 0.55 + mod(row, 2.0) * 0.5;
          float mortar = max(1.0 - smoothstep(0.0, 0.12, fract(c)), 1.0 - smoothstep(0.0, 0.05, fract(bx)));
          albedo *= (1.0 - 0.3 * mortar * fine) * (1.0 + 0.16 * (wallHash(vec2(floor(bx), row)) - 0.5) * fine);
        } else if (fMat < 1.5) {                                                    // stone: irregular blocks
          float c = fV / 0.45, row = floor(c), bx = fAlong / 0.95 + wallHash(vec2(row, 3.0)) * 3.0;
          float mortar = max(1.0 - smoothstep(0.0, 0.07, fract(c)), 1.0 - smoothstep(0.0, 0.035, fract(bx)));
          albedo *= (1.0 - 0.22 * mortar * fine) * (0.86 + 0.28 * wallHash(vec2(floor(bx), row)) * coarse + 0.14 * (1.0 - coarse));
        } else if (fMat > 2.5) {                                                    // cladding: vertical ribs
          albedo *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.1, fract(fAlong / 0.6))) * fine;
        }
        albedo *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.5, fV));                      // damp plinth
        albedo = mix(albedo, vec3(0.62), 0.3 * (1.0 - smoothstep(0.0, 0.22, fTop - fV)) * step(0.0, fTop - fV));   // coping along the top
        if (fWin > 0.5 && fL > 2.4) {
          float margin = fWin > 2.5 ? 1.8 : 1.0, usable = fL - 2.0 * margin;
          float bayT = (fWin < 1.5 ? 3.1 : fWin < 2.5 ? 3.2 : 4.2) * (0.9 + 0.25 * fract(fSeed * 11.0));
          float u = fAlong - margin;
          if (usable > 1.2 && u > 0.0 && u < usable) {
            float n = max(1.0, floor(usable / bayT + 0.5)), bw = usable / n, bi = floor(u / bw), lx = u - (bi + 0.5) * bw;
            float k = floor(fV / fFloor), ly = fV - k * fFloor, fits = step((k + 1.0) * fFloor, fTop - 0.3);
            float ww = fWin < 1.5 ? 1.2 : fWin < 2.5 ? min(bw * 0.72, 2.6) : 1.1, wh = fWin < 1.5 ? 1.5 : fWin < 2.5 ? 1.9 : 4.2, sill = fWin < 2.5 ? 0.3 * fFloor : 1.8;
            if (fWin > 2.5) ww *= 1.0 - max(0.0, ((ly - sill) / wh - 0.7) / 0.3);   // pointed arch head
            float isDoor = 0.0, isShop = 0.0;
            if (k < 0.5) {
              if (fShop > 0.5 && fWin < 3.5) { isShop = 1.0; ww = bw * 0.86; wh = min(2.5, fFloor - 0.6); sill = 0.4; }
              else if (fWin < 2.5 && wallHash(vec2(bi, fSeed * 97.0)) < 0.22) { isDoor = 1.0; ww = 1.0; wh = 2.1; sill = 0.0; }
            }
            float a = px * 1.2;
            float inX = smoothstep(-ww * 0.5 - a, -ww * 0.5 + a, lx) * (1.0 - smoothstep(ww * 0.5 - a, ww * 0.5 + a, lx));
            float inY = smoothstep(sill - a, sill + a, ly) * (1.0 - smoothstep(sill + wh - a, sill + wh + a, ly));
            float inside = inX * inY * fits * coarse;
            float edge = min(min(lx + ww * 0.5, ww * 0.5 - lx), min(ly - sill, sill + wh - ly));         // metres in from the edge of the opening
            vec3 frameCol = fWin > 1.5 ? vec3(0.08, 0.085, 0.09) : fract(fSeed * 13.0) < 0.6 ? vec3(0.8, 0.8, 0.76) : vec3(0.1, 0.08, 0.07);
            vec3 glass = mix(vec3(0.1, 0.13, 0.17), vec3(0.34, 0.42, 0.5), smoothstep(0.0, 1.0, (ly - sill) / wh));
            vec3 doorCol = fract(fSeed * 29.0) < 0.25 ? vec3(0.05, 0.14, 0.3) : fract(fSeed * 29.0) < 0.5 ? vec3(0.4, 0.07, 0.06) : fract(fSeed * 29.0) < 0.75 ? vec3(0.04, 0.2, 0.1) : vec3(0.06, 0.05, 0.05);
            vec3 opening = isDoor > 0.5 ? doorCol : mix(glass, frameCol, 1.0 - smoothstep(fWin > 1.5 ? 0.07 : 0.04, fWin > 1.5 ? 0.14 : 0.09, edge));
            if (isDoor < 0.5 && isShop < 0.5 && fWin < 2.5) opening = mix(opening, frameCol, 0.9 * (1.0 - smoothstep(0.0, 0.05, abs(lx))) * fine + 0.8 * (1.0 - smoothstep(0.0, 0.05, abs(ly - sill - wh * 0.6))) * fine * inX);   // sash bars
            albedo = mix(albedo, opening, inside);
            float onSill = smoothstep(sill - 0.1 - a, sill - 0.1 + a, ly) * (1.0 - smoothstep(sill - a, sill + a, ly)) * inX * step(0.5, 1.0 - isDoor) * fits * coarse;
            albedo = mix(albedo, vec3(0.7, 0.68, 0.62), 0.8 * onSill);
            if (isShop > 0.5) {                                                      // a fascia sign above the shopfront
              float fas = smoothstep(sill + wh + 0.12 - a, sill + wh + 0.12 + a, ly) * (1.0 - smoothstep(sill + wh + 0.72 - a, sill + wh + 0.72 + a, ly)) * smoothstep(-bw * 0.5, -bw * 0.5 + 0.05, lx) * (1.0 - smoothstep(bw * 0.5 - 0.05, bw * 0.5, lx));
              albedo = mix(albedo, mix(vec3(0.06, 0.1, 0.2), vec3(0.3, 0.06, 0.05), step(0.5, fract(fSeed * 17.0))), 0.9 * fas * fits * coarse);
            }
          }
        }
        wallCol = albedo;`;

/** Wall shading: needs the `wallDetail` (along metres, elevation metres) and `wallEdge` (edge start uv, end uv) attributes. */
export function addWallPatchwork(material, { patchM = WALL_PATCH_M, variation = WALL_VARIATION, mottle = WALL_MOTTLE } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPatchM = { value: patchM };
    shader.uniforms.uVariation = { value: variation };
    shader.uniforms.uMottle = { value: mottle };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 wallDetail;\nattribute vec4 wallEdge;\nattribute vec4 wallFacade;\nattribute vec4 wallLook;\nattribute vec4 wallTint;\nvarying vec2 vWallDetail;\nvarying vec4 vWallEdge;\nvarying vec4 vFacade;\nvarying vec4 vLook;\nvarying vec4 vTint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWallDetail = wallDetail;\nvWallEdge = wallEdge;\nvFacade = wallFacade;\nvLook = wallLook;\nvTint = wallTint;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vWallDetail;
        varying vec4 vWallEdge;
        varying vec4 vFacade;   // base elevation, wall top elevation at this column, wall length, floor height
        varying vec4 vLook;     // material, window style, seed, shopfront
        varying vec4 vTint;     // tagged colour rgb, strength
        uniform float uPatchM;
        uniform float uVariation;
        uniform float uMottle;
        float wallHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wallNoise(vec2 p) { // smooth value noise, 0..1
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wallHash(i), wallHash(i + vec2(1.0, 0.0)), f.x), mix(wallHash(i + vec2(0.0, 1.0)), wallHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <map_fragment>', `
        vec3 wallMean = vec3(0.0);
        for (int i = 0; i < 8; i++) wallMean += texture2D(map, mix(vWallEdge.xy, vWallEdge.zw, (float(i) + 0.5) / 8.0)).rgb;
        wallMean /= 8.0;
        vec2 wallP = vWallDetail / uPatchM + vWallEdge.xy * 1000.0;               // per-wall offset so walls differ
        float wallT = wallNoise(wallP * 1.0);                                      // where along the edge to borrow a colour from
        wallT = clamp((wallT - 0.5) * 2.2 + 0.5, 0.0, 1.0);                        // noise clusters near 0.5; stretch it to use the full edge
        vec3 wallPick = texture2D(map, mix(vWallEdge.xy, vWallEdge.zw, wallT)).rgb;
        float wallMottleN = wallNoise(wallP * 3.1 + 17.0) * 0.6 + wallNoise(wallP * 7.3 + 5.0) * 0.4;
        vec3 wallCol = mix(wallMean, wallPick, uVariation) * (1.0 + uMottle * (wallMottleN * 2.0 - 1.0) * 1.6);
        ${FACADE_GLSL}
        vec4 sampledDiffuseColor = vec4(wallCol, 1.0);
        diffuseColor *= sampledDiffuseColor;`);
  };
  material.customProgramCacheKey = () => 'wallfacade2';
  material.needsUpdate = true;
}

const signedArea = (ring) => ring.reduce((s, [x0, y0], i) => { const [x1, y1] = ring[(i + 1) % ring.length]; return s + (x0 * y1 - x1 * y0); }, 0) / 2;

/** Drop the repeated closing point; orient the outer ring counter-clockwise and holes clockwise (seen from above). */
function normaliseRings(rings) {
  return rings.map((r, i) => {
    const pts = r.slice(0, r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? -1 : undefined);
    return (signedArea(pts) > 0) === (i === 0) ? pts : pts.slice().reverse();
  }).filter((r) => r.length >= 3);
}

/** Nearest footprint-edge point to (x, y) over all rings: { qx, qy, d, nx, ny } with (nx, ny) the unit inward normal. */
function nearestEdge(rings, x, y) {
  let best = { d2: Infinity };
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const qx = ax + t * dx, qy = ay + t * dy, d2 = (x - qx) ** 2 + (y - qy) ** 2;
      if (d2 < best.d2) { const len = Math.sqrt(len2); best = { d2, qx, qy, nx: -dy / len, ny: dx / len }; } // rings are CCW outer / CW holes: the left normal points into the building
    }
  }
  return { qx: best.qx, qy: best.qy, d: Math.sqrt(best.d2), nx: best.nx, ny: best.ny };
}

/** The roof height at a footprint edge point (a `nearestEdge` result): a high percentile of the DSM a little way inside it, or null if there is no inside. */
function eaveHeight(rings, surface, e) {
  const zs = [];
  for (const t of EAVE_SPREAD_M) for (const d of EAVE_DEPTHS_M) { const x = e.qx - e.ny * t + e.nx * d, y = e.qy + e.nx * t + e.ny * d; if (inside(rings, x, y)) zs.push(sampleHeight(surface, x, y)); }
  if (!zs.length) return null;
  zs.sort((a, b) => a - b);
  return zs[Math.min(zs.length - 1, Math.floor(EAVE_PERCENTILE * (zs.length - 1) + 0.5))];
}

/** Points along edge p->q, split by repeated halving until every piece is at most maxLen. Includes both ends. */
function splitEdge(p, q, maxLen, depth = 0) {
  if (depth >= MAX_REFINE_PASSES || Math.hypot(q[0] - p[0], q[1] - p[1]) <= maxLen) return [p, q];
  const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return [...splitEdge(p, m, maxLen, depth + 1).slice(0, -1), ...splitEdge(m, q, maxLen, depth + 1)];
}

const CREASE_EPS = 1e-6;
/** Points along p->q split at every crease it crosses (a crease is a signed-distance function; a crossing is a sign change), then by halving to maxLen. */
function splitEdgeAtCreases(p, q, maxLen, creases) {
  const cuts = [];
  for (const c of creases) { const a = c(p[0], p[1]), b = c(q[0], q[1]); if (a * b < 0 && Math.abs(a) > CREASE_EPS && Math.abs(b) > CREASE_EPS) cuts.push(a / (a - b)); }
  cuts.sort((s, t) => s - t);
  const pts = [p, ...cuts.map((t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]), q];
  return pts.flatMap((a, i) => (i + 1 < pts.length ? splitEdge(a, pts[i + 1], maxLen).slice(i ? 1 : 0) : []));
}

/**
 * Conforming refinement: split every edge longer than maxLen at its midpoint (midpoints are shared between the
 * triangles on either side, so there are no cracks) and repeat. An edge that crosses a crease (see fitRoof) is split exactly where it
 * crosses, whatever its length, so the roof bends along a line of edges. Winding is preserved.
 */
function refineTriangles(verts, tris, maxLen, creases = []) {
  for (let pass = 0; pass < MAX_REFINE_PASSES; pass++) {
    const mids = new Map();
    let any = false;
    const midOf = (i, j) => {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      let m = mids.get(key);
      if (m === undefined) {
        const [ax, ay] = verts[i], [bx, by] = verts[j];
        let t = -1;
        for (const c of creases) { const ca = c(ax, ay), cb = c(bx, by); if (ca * cb < 0 && Math.abs(ca) > CREASE_EPS && Math.abs(cb) > CREASE_EPS) { t = ca / (ca - cb); break; } }
        if (t < 0 && Math.hypot(bx - ax, by - ay) > maxLen) t = 0.5;
        if (t >= 0) { m = verts.push([ax + (bx - ax) * t, ay + (by - ay) * t]) - 1; any = true; } else m = -1;
        mids.set(key, m);
      }
      return m;
    };
    const next = [];
    for (const [a, b, c] of tris) {
      const ab = midOf(a, b), bc = midOf(b, c), ca = midOf(c, a);
      const n = (ab >= 0) + (bc >= 0) + (ca >= 0);
      if (n === 0) next.push([a, b, c]);
      else if (n === 3) next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      else if (n === 1) {
        if (ab >= 0) next.push([a, ab, c], [ab, b, c]);
        else if (bc >= 0) next.push([b, bc, a], [bc, c, a]);
        else next.push([c, ca, b], [ca, a, b]);
      } else { // two split edges: rotate so the unsplit edge is r->p
        const [p, q, r, mpq, mqr] = ab < 0 ? [b, c, a, bc, ca] : bc < 0 ? [c, a, b, ca, ab] : [a, b, c, ab, bc];
        next.push([q, mqr, mpq], [p, mpq, mqr], [p, mqr, r]);
      }
    }
    tris = next;
    if (!any) break;
  }
  return tris;
}

/**
 * Extrudes every footprint from base_z up to its roof.
 * Without `surface` (a heightmap-like object from the bundle's surfacemap) every roof is flat at base_z + height.
 * With it, the roof follows the LiDAR DSM: roofs are refined to ROOF_GRID_M triangles whose vertex heights are
 * sampled from the surface, and each wall's top edge follows the roof edge.
 * Returns two merged geometries: `walls` (own quads per edge, flat normals; UVs point at the imagery pixels along the
 * footprint edge, so each wall takes the colours of the satellite image it stands on) and `roofs` (caps with the same planar imagery UVs as the terrain, so roofs show the real roof pixels).
 */
export function buildBuildingGeometry(meta, buildings, surface = null) {
  const [W, H] = meta.size_m;
  const wp = [], wn = [], wuv = [], wdt = [], wedge = [], wi = [], wfac = [], wlook = [], wtint = [];
  const rp = [], rn = [], ruv = [], ri = [];

  for (const f of buildings.features) {
    if (f.geometry?.type !== 'Polygon') continue;
    const rings = normaliseRings(f.geometry.coordinates);
    if (!rings.length) continue;
    const base = f.properties.base_z ?? meta.heightmap.min;
    const height = f.properties.height ?? DEFAULT_HEIGHT_M;
    const flatTop = base + height;
    const look = facadeLook(f.properties, height);
    // Per-wall facade inputs for the shader (see FACADE_GLSL): base elevation, the wall's top elevation at each end, its length and the floor height, then the look
    const pushFacade = (top0, top1, length) => {
      for (const top of [top0, top1, top1, top0]) { wfac.push(base, top, length, look.floorHeight); wlook.push(look.material, look.windows, look.seed, look.shopfront); wtint.push(...look.tint); }
    };
    // Absolute roof elevation at a footprint point: the DSM, kept between a floor and a cap so tree canopy and
    // gaps cannot make a roof spike or sink through the ground.
    const fit = surface ? fitBuildingRoof(rings, (x, y) => sampleHeight(surface, x, y), (x, y) => nearestEdge(rings, x, y).d, { groundZ: base + GROUND_ABOVE_BASE_M }) : null;      // null: no simple roof fits, use the raw DSM
    const clampZ = (z) => Math.min(base + 2 * height + 2, Math.max(base + MIN_ROOF_ABOVE_BASE_M, z));
    // `zone` (fitted roofs only) says which zone's roof to read: a point on a cut belongs to two, so the caller picks (a wall piece by its middle)
    const roofZ = fit ? (x, y, zone = fit.zoneAt(x, y)) => clampZ(zone.model.z(x, y)) : surface
      ? (x, y) => {
          const e = nearestEdge(rings, x, y), eave = eaveHeight(rings, surface, e);
          let z;
          if (e.d < ROOF_INSET_M) z = eave ?? sampleHeight(surface, e.qx + e.nx * ROOF_INSET_M, e.qy + e.ny * ROOF_INSET_M);
          else { z = sampleHeight(surface, x, y); if (eave !== null && e.d < RIM_DEPTH_M) z = Math.max(z, eave); }
          return Math.min(base + 2 * height + 2, Math.max(base + MIN_ROOF_ABOVE_BASE_M, z));
        }
      : () => flatTop;
    const maxLen = fit ? fit.maxLen : surface ? ROOF_GRID_M : Infinity, creases = fit?.creases ?? [];

    // Walls: one quad per edge piece. With the outer ring CCW (and holes CW) the outward normal is (dy, -dx) in local x/y.
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (len < 1e-6) continue;
        const nx2 = (p1[1] - p0[1]) / len, ny2 = -(p1[0] - p0[0]) / len; // outward normal in local x/y
        const nx = nx2, nz = -ny2; // world normal (world Z = -y)
        // Sample point per end: moved WALL_SAMPLE_INSET_M into the building (against the outward normal).
        const sx = -nx2 * WALL_SAMPLE_INSET_M, sy = -ny2 * WALL_SAMPLE_INSET_M;
        const pts = splitEdgeAtCreases(p0, p1, maxLen, creases);
        for (let j = 0; j + 1 < pts.length; j++) {
          const [x0, y0] = pts[j], [x1, y1] = pts[j + 1];
          const zone = fit?.zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
          if (zone?.ground) continue;                                  // no building here: the outline takes in bare ground
          const k = wp.length / 3, z0 = roofZ(x0, y0, zone), z1 = roofZ(x1, y1, zone);
          wp.push(...toWorld(meta, x0, y0, base), ...toWorld(meta, x1, y1, base), ...toWorld(meta, x1, y1, z1), ...toWorld(meta, x0, y0, z0));
          for (let n = 0; n < 4; n++) wn.push(nx, 0, nz);
          const a = [(x0 + sx) / W, 1 - (y0 + sy) / H], b = [(x1 + sx) / W, 1 - (y1 + sy) / H];
          wuv.push(...a, ...b, ...b, ...a); // same UV top and bottom: colour is constant up each wall
          // Patchwork inputs: metres along this wall (from its first corner) and elevation, plus the imagery UVs
          // of the whole edge's two ends, so every piece of a wall draws from the same colours.
          const ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
          const along = (x, y) => (x - p0[0]) * ux + (y - p0[1]) * uy;
          wdt.push(along(x0, y0), base, along(x1, y1), base, along(x1, y1), z1, along(x0, y0), z0);
          pushFacade(z0, z1, len);
          const eA = [(p0[0] + sx) / W, 1 - (p0[1] + sy) / H], eB = [(p1[0] + sx) / W, 1 - (p1[1] + sy) / H];
          for (let n = 0; n < 4; n++) wedge.push(...eA, ...eB);
          wi.push(k, k + 1, k + 2, k, k + 2, k + 3);
        }
      }
    }

    // Roof: triangulate outer ring with holes, refine (pitched roofs only), then fix winding so every triangle faces up in world space.
    const flat = rings.flatMap((r) => r);
    const base2d = THREE.ShapeUtils.triangulateShape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)), rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y))));
    const verts = flat.map(([x, y]) => [x, y]);
    const tris = surface ? refineTriangles(verts, base2d, maxLen, creases) : base2d;
    const upFace = (ia, ib, ic, a, b, c) => {       // push one roof triangle, wound so it faces up in world space
      const [ax, ay] = verts[a], [bx, by] = verts[b], [cx, cy] = verts[c];
      const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0; // CCW in local x/y
      if (ccw) ri.push(ia, ib, ic); else ri.push(ia, ic, ib);       // world Z = -y mirrors the plan, but three's front face is CCW seen from above (+Y)
    };
    if (fit && fit.zones.length > 1) {
      // Several zones: each triangle belongs to the zone its centre is in, and takes that zone's heights. A vertex on a cut is shared by triangles of
      // two zones, so it is duplicated, one copy per zone; then a vertical step face fills the gap along every edge on a cut between two zones.
      const copy = new Map(), onCut = new Map(), stride = verts.length + 1;
      const vertexIn = (v, zone) => {
        const key = v * 64 + zone.id; let i = copy.get(key);
        if (i === undefined) { const [x, y] = verts[v]; i = rp.length / 3; rp.push(...toWorld(meta, x, y, roofZ(x, y, zone))); rn.push(0, 1, 0); ruv.push(x / W, 1 - y / H); copy.set(key, i); }
        return i;
      };
      const onSameCut = (u, v) => fit.lines.some((L) => Math.abs(L(verts[u][0], verts[u][1])) < CREASE_EPS && Math.abs(L(verts[v][0], verts[v][1])) < CREASE_EPS);
      for (const [a, b, c] of tris) {
        const cx = (verts[a][0] + verts[b][0] + verts[c][0]) / 3, cy = (verts[a][1] + verts[b][1] + verts[c][1]) / 3, zone = fit.zoneAt(cx, cy);
        if (!zone.ground) upFace(vertexIn(a, zone), vertexIn(b, zone), vertexIn(c, zone), a, b, c);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          if (!onSameCut(u, v)) continue;
          const key = Math.min(u, v) * stride + Math.max(u, v), e = onCut.get(key) ?? { u, v, zones: new Map() };
          if (!e.zones.has(zone.id)) e.zones.set(zone.id, { zone, cx, cy });
          onCut.set(key, e);
        }
      }
      for (const { u, v, zones } of onCut.values()) {
        if (zones.size !== 2) continue;                                // an edge with one zone is on the outline, not between two roofs
        const [A, B] = [...zones.values()];
        const level = (p, Z) => (Z.zone.ground ? base : roofZ(p[0], p[1], Z.zone));      // beside bare ground the step goes right down to the base
        const hu = [level(verts[u], A), level(verts[u], B)], hv = [level(verts[v], A), level(verts[v], B)];
        if (Math.abs(hu[0] - hu[1]) < 0.05 && Math.abs(hv[0] - hv[1]) < 0.05) continue;       // the two roofs meet level: no step
        const lowerIsA = hu[0] + hv[0] < hu[1] + hv[1], lower = lowerIsA ? A : B;
        let p0 = verts[u], p1 = verts[v], l0 = Math.min(...hu), l1 = Math.min(...hv), h0 = Math.max(...hu), h1 = Math.max(...hv);
        // wind like the outline walls: the face looks out to the right of p0 -> p1, which has to be the lower roof's side
        if ((p1[0] - p0[0]) * (lower.cy - p0[1]) - (p1[1] - p0[1]) * (lower.cx - p0[0]) > 0) { [p0, p1] = [p1, p0]; [l0, l1] = [l1, l0]; [h0, h1] = [h1, h0]; }
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (len < 1e-6) continue;
        const nx2 = (p1[1] - p0[1]) / len, ny2 = -(p1[0] - p0[0]) / len, sx = -nx2 * WALL_SAMPLE_INSET_M, sy = -ny2 * WALL_SAMPLE_INSET_M, k = wp.length / 3;
        wp.push(...toWorld(meta, p0[0], p0[1], l0), ...toWorld(meta, p1[0], p1[1], l1), ...toWorld(meta, p1[0], p1[1], h1), ...toWorld(meta, p0[0], p0[1], h0));
        for (let n = 0; n < 4; n++) wn.push(nx2, 0, -ny2);
        const ua = [(p0[0] + sx) / W, 1 - (p0[1] + sy) / H], ub = [(p1[0] + sx) / W, 1 - (p1[1] + sy) / H];
        wuv.push(...ua, ...ub, ...ub, ...ua);
        wdt.push(0, l0, len, l1, len, h1, 0, h0);
        pushFacade(h0, h1, len);
        for (let n = 0; n < 4; n++) wedge.push(...ua, ...ub);
        wi.push(k, k + 1, k + 2, k, k + 2, k + 3);
      }
    } else {
      const k0 = rp.length / 3;
      for (const [x, y] of verts) {
        rp.push(...toWorld(meta, x, y, roofZ(x, y)));
        rn.push(0, 1, 0);
        ruv.push(x / W, 1 - y / H);
      }
      for (const [a, b, c] of tris) upFace(k0 + a, k0 + b, k0 + c, a, b, c);
    }
  }

  const make = (p, n, uv, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  };
  const wallGeo = make(wp, wn, wuv, wi);
  wallGeo.setAttribute('wallDetail', new THREE.Float32BufferAttribute(wdt, 2));
  wallGeo.setAttribute('wallEdge', new THREE.Float32BufferAttribute(wedge, 4));
  wallGeo.setAttribute('wallFacade', new THREE.Float32BufferAttribute(wfac, 4));
  wallGeo.setAttribute('wallLook', new THREE.Float32BufferAttribute(wlook, 4));
  wallGeo.setAttribute('wallTint', new THREE.Float32BufferAttribute(wtint, 4));
  return { walls: wallGeo, roofs: make(rp, rn, ruv, ri) };
}

export function buildBuildings(meta, buildings, imageryTex, surface = null, renderer = null) {
  const { walls, roofs } = buildBuildingGeometry(meta, buildings, surface);
  const group = new THREE.Group(); group.name = 'buildings';
  const wallMat = new THREE.MeshLambertMaterial({ map: imageryTex, color: new THREE.Color().setRGB(WALL_BRIGHTNESS, WALL_BRIGHTNESS, WALL_BRIGHTNESS, THREE.SRGBColorSpace) });
  addWallPatchwork(wallMat);
  const wallMesh = new THREE.Mesh(walls, wallMat);
  const roofMesh = new THREE.Mesh(roofs, new THREE.MeshBasicMaterial({ map: imageryTex, side: THREE.DoubleSide }));
  wallMesh.name = 'walls'; roofMesh.name = 'roofs';
  group.add(wallMesh, roofMesh);
  return group;
}
