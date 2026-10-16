import * as THREE from 'three';
import { toWorld } from './coords.js';
import { sampleHeight } from './heightmap.js';

export const DEFAULT_HEIGHT_M = 6;
// Walls are coloured by the imagery just inside the footprint edge: sampling exactly on the edge often hits the
// ground or a shadow, because aerial photos lean tall buildings away from their footprints.
export const WALL_SAMPLE_INSET_M = 0.75;
// Walls copy the imagery at 75% of its brightness (tuned by eye with the owner: 50% and 25% were too dark), so they
// read as shaded verticals next to the roofs. Set as an sRGB grey, so it scales the displayed pixel values.
export const WALL_BRIGHTNESS = 0.75;

// Pitched roofs (when the bundle has a surfacemap): roof/wall-top heights come from the LiDAR DSM.
export const ROOF_GRID_M = 2;          // roofs are refined until no edge is longer than this
export const ROOF_INSET_M = 1.5;       // within this distance of the footprint edge the DSM is read on this inset line, so the roof edge is crisp (walls drop vertically from it) and not smeared with the ground or a neighbour
export const MIN_ROOF_ABOVE_BASE_M = 2;
const MAX_REFINE_PASSES = 10;

// Wall texture: instead of one colour per vertical band, each wall is a random patchwork of all the colours found
// along that wall's footprint edge. The fragment shader splits the wall into WALL_PATCH_M cells and gives each cell a
// pseudo-random position along the edge, then looks the colour up in the imagery there. Cells are addressed in metres
// along the wall and up it, so patches are continuous across the pieces a wall is split into.
export const WALL_PATCH_M = 0.5;

/** Patchwork walls: needs the `wallDetail` (along metres, elevation metres) and `wallEdge` (edge start uv, end uv) attributes. */
export function addWallPatchwork(material, patchM = WALL_PATCH_M) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPatchM = { value: patchM };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 wallDetail;\nattribute vec4 wallEdge;\nvarying vec2 vWallDetail;\nvarying vec4 vWallEdge;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWallDetail = wallDetail;\nvWallEdge = wallEdge;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vWallDetail;
        varying vec4 vWallEdge;
        uniform float uPatchM;
        float wallHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
        vec2 wallCell = floor(vWallDetail / uPatchM);
        float wallT = wallHash(wallCell + vWallEdge.xy * 1000.0);
        vec4 sampledDiffuseColor = texture2D(map, mix(vWallEdge.xy, vWallEdge.zw, wallT));
        diffuseColor *= sampledDiffuseColor;`);
  };
  material.customProgramCacheKey = () => 'wallpatchwork';
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

/** Points along edge p->q, split by repeated halving until every piece is at most maxLen. Includes both ends. */
function splitEdge(p, q, maxLen, depth = 0) {
  if (depth >= MAX_REFINE_PASSES || Math.hypot(q[0] - p[0], q[1] - p[1]) <= maxLen) return [p, q];
  const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return [...splitEdge(p, m, maxLen, depth + 1).slice(0, -1), ...splitEdge(m, q, maxLen, depth + 1)];
}

/**
 * Conforming refinement: split every edge longer than maxLen at its midpoint (midpoints are shared between the
 * triangles on either side, so there are no cracks) and repeat. Winding is preserved.
 */
function refineTriangles(verts, tris, maxLen) {
  for (let pass = 0; pass < MAX_REFINE_PASSES; pass++) {
    const mids = new Map();
    let any = false;
    const midOf = (i, j) => {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      let m = mids.get(key);
      if (m === undefined) {
        const [ax, ay] = verts[i], [bx, by] = verts[j];
        if (Math.hypot(bx - ax, by - ay) > maxLen) { m = verts.push([(ax + bx) / 2, (ay + by) / 2]) - 1; any = true; } else m = -1;
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
  const wp = [], wn = [], wuv = [], wdt = [], wedge = [], wi = [];
  const rp = [], rn = [], ruv = [], ri = [];

  for (const f of buildings.features) {
    if (f.geometry?.type !== 'Polygon') continue;
    const rings = normaliseRings(f.geometry.coordinates);
    if (!rings.length) continue;
    const base = f.properties.base_z ?? meta.heightmap.min;
    const height = f.properties.height ?? DEFAULT_HEIGHT_M;
    const flatTop = base + height;
    // Absolute roof elevation at a footprint point: the DSM, kept between a floor and a cap so tree canopy and
    // gaps cannot make a roof spike or sink through the ground.
    const roofZ = surface
      ? (x, y) => {
          const e = nearestEdge(rings, x, y);
          const z = e.d < ROOF_INSET_M ? sampleHeight(surface, e.qx + e.nx * ROOF_INSET_M, e.qy + e.ny * ROOF_INSET_M) : sampleHeight(surface, x, y);
          return Math.min(base + 2 * height + 2, Math.max(base + MIN_ROOF_ABOVE_BASE_M, z));
        }
      : () => flatTop;
    const maxLen = surface ? ROOF_GRID_M : Infinity;

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
        const pts = splitEdge(p0, p1, maxLen);
        for (let j = 0; j + 1 < pts.length; j++) {
          const [x0, y0] = pts[j], [x1, y1] = pts[j + 1];
          const k = wp.length / 3;
          wp.push(...toWorld(meta, x0, y0, base), ...toWorld(meta, x1, y1, base), ...toWorld(meta, x1, y1, roofZ(x1, y1)), ...toWorld(meta, x0, y0, roofZ(x0, y0)));
          for (let n = 0; n < 4; n++) wn.push(nx, 0, nz);
          const a = [(x0 + sx) / W, 1 - (y0 + sy) / H], b = [(x1 + sx) / W, 1 - (y1 + sy) / H];
          wuv.push(...a, ...b, ...b, ...a); // same UV top and bottom: colour is constant up each wall
          // Patchwork inputs: metres along this wall (from its first corner) and elevation, plus the imagery UVs
          // of the whole edge's two ends, so every piece of a wall draws from the same colours.
          const ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
          const along = (x, y) => (x - p0[0]) * ux + (y - p0[1]) * uy;
          wdt.push(along(x0, y0), base, along(x1, y1), base, along(x1, y1), roofZ(x1, y1), along(x0, y0), roofZ(x0, y0));
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
    const tris = surface ? refineTriangles(verts, base2d, maxLen) : base2d;
    const k0 = rp.length / 3;
    for (const [x, y] of verts) {
      rp.push(...toWorld(meta, x, y, roofZ(x, y)));
      rn.push(0, 1, 0);
      ruv.push(x / W, 1 - y / H);
    }
    for (const [a, b, c] of tris) {
      const [ax, ay] = verts[a], [bx, by] = verts[b], [cx, cy] = verts[c];
      const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0; // CCW in local x/y
      if (ccw) ri.push(k0 + a, k0 + b, k0 + c); else ri.push(k0 + a, k0 + c, k0 + b); // world Z = -y mirrors the plan, but three's front face is CCW seen from above (+Y)
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
