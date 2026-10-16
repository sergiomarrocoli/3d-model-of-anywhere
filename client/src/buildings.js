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

// Wall detail: a brick pattern multiplied over the per-wall imagery colour, so walls keep their sampled colours
// but read as masonry instead of smooth vertical bands. Stylised at about twice real brick size so it shows
// at game zoom. Detail UVs are in tile units: along the wall (continuous across the corners of one wall) and up.
export const WALL_TILE_M = [0.86, 0.52];   // one texture tile: 2 bricks across, 4 courses up
const BRICKS_ACROSS = 2, COURSES = 4;

/** Greyscale brick tile (RGBA bytes, mean about 1.0 when read as a multiplier) with a seeded per-brick tone. */
export function brickTileData(size = 128, seed = 7) {
  const data = new Uint8Array(size * size * 4);
  const rnd = (i, j) => { let h = (i * 374761393 + j * 668265263 + seed * 2147483647) >>> 0; h = (h ^ (h >>> 13)) * 1274126177 >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  const ch = size / COURSES, bw = size / BRICKS_ACROSS, mortar = Math.max(2, Math.round(size / 48));
  for (let py = 0; py < size; py++) {
    const course = Math.floor(py / ch), inCourse = py - course * ch;
    const shift = course % 2 ? bw / 2 : 0;                       // running bond
    for (let px = 0; px < size; px++) {
      const bx = (px + shift) % size, brick = Math.floor(bx / bw), inBrick = bx - brick * bw;
      const edge = inCourse < mortar || inBrick < mortar;
      const tone = 0.82 + 0.36 * rnd(brick + (course % 2 ? 100 : 0), course); // 0.82..1.18 per brick
      const v = edge ? 0.62 : tone;
      const o = (py * size + px) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.max(0, Math.min(255, Math.round(v * 255 * 0.9))); data[o + 3] = 255;
    }
  }
  return data;
}

export function wallDetailTexture(renderer = null) {
  const size = 128;
  const tex = new THREE.DataTexture(brickTileData(size), size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  tex.needsUpdate = true;
  return tex;
}

/** Multiply a lit material's diffuse colour by a tiled detail texture addressed by the `detailUv` attribute. */
export function addWallDetail(material, detailTex, strength = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detailTex };
    shader.uniforms.uDetailStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 detailUv;\nvarying vec2 vDetailUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDetailUv = detailUv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDetailUv;\nuniform sampler2D uDetail;\nuniform float uDetailStrength;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(vec3(1.0), texture2D(uDetail, vDetailUv).rgb, uDetailStrength);');
  };
  material.customProgramCacheKey = () => 'walldetail';
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
  const wp = [], wn = [], wuv = [], wdt = [], wi = [];
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
          // Detail UVs in tile units: distance along this wall (from its first corner) and absolute elevation.
          const ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
          const along = (x, y) => ((x - p0[0]) * ux + (y - p0[1]) * uy) / WALL_TILE_M[0];
          const up = (z) => z / WALL_TILE_M[1];
          wdt.push(along(x0, y0), up(base), along(x1, y1), up(base), along(x1, y1), up(roofZ(x1, y1)), along(x0, y0), up(roofZ(x0, y0)));
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
  wallGeo.setAttribute('detailUv', new THREE.Float32BufferAttribute(wdt, 2));
  return { walls: wallGeo, roofs: make(rp, rn, ruv, ri) };
}

export function buildBuildings(meta, buildings, imageryTex, surface = null, renderer = null) {
  const { walls, roofs } = buildBuildingGeometry(meta, buildings, surface);
  const group = new THREE.Group(); group.name = 'buildings';
  const wallMat = new THREE.MeshLambertMaterial({ map: imageryTex, color: new THREE.Color().setRGB(WALL_BRIGHTNESS, WALL_BRIGHTNESS, WALL_BRIGHTNESS, THREE.SRGBColorSpace) });
  addWallDetail(wallMat, wallDetailTexture(renderer));
  const wallMesh = new THREE.Mesh(walls, wallMat);
  const roofMesh = new THREE.Mesh(roofs, new THREE.MeshBasicMaterial({ map: imageryTex, side: THREE.DoubleSide }));
  wallMesh.name = 'walls'; roofMesh.name = 'roofs';
  group.add(wallMesh, roofMesh);
  return group;
}
