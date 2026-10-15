import * as THREE from 'three';
import { toWorld } from './coords.js';

export const DEFAULT_HEIGHT_M = 6;
// Walls are coloured by the imagery just inside the footprint edge: sampling exactly on the edge often hits the
// ground or a shadow, because aerial photos lean tall buildings away from their footprints.
export const WALL_SAMPLE_INSET_M = 0.75;
// Walls copy the imagery at a quarter of its brightness (halved twice, at the owner's request), so they read as
// dark shaded verticals next to the roofs. Set as an sRGB grey, so it scales the displayed pixel values.
export const WALL_BRIGHTNESS = 0.25;

const signedArea = (ring) => ring.reduce((s, [x0, y0], i) => { const [x1, y1] = ring[(i + 1) % ring.length]; return s + (x0 * y1 - x1 * y0); }, 0) / 2;

/** Drop the repeated closing point; orient the outer ring counter-clockwise and holes clockwise (seen from above). */
function normaliseRings(rings) {
  return rings.map((r, i) => {
    const pts = r.slice(0, r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? -1 : undefined);
    return (signedArea(pts) > 0) === (i === 0) ? pts : pts.slice().reverse();
  }).filter((r) => r.length >= 3);
}

/**
 * Extrudes every footprint from base_z to base_z + height.
 * Returns two merged geometries: `walls` (own quads per edge, flat normals; UVs point at the imagery pixels along the
 * footprint edge, so each wall takes the colours of the satellite image it stands on) and `roofs` (flat caps with the same planar imagery UVs as the terrain, so roofs show the real roof pixels).
 */
export function buildBuildingGeometry(meta, buildings) {
  const [W, H] = meta.size_m;
  const wp = [], wn = [], wuv = [], wi = [];
  const rp = [], rn = [], ruv = [], ri = [];

  for (const f of buildings.features) {
    if (f.geometry?.type !== 'Polygon') continue;
    const rings = normaliseRings(f.geometry.coordinates);
    if (!rings.length) continue;
    const base = f.properties.base_z ?? meta.heightmap.min;
    const height = f.properties.height ?? DEFAULT_HEIGHT_M;
    const top = base + height;

    // Walls: one quad per edge. With the outer ring CCW (and holes CW) the outward normal is (dy, -dx) in local x/y.
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-6) continue;
        const k = wp.length / 3;
        wp.push(...toWorld(meta, x0, y0, base), ...toWorld(meta, x1, y1, base), ...toWorld(meta, x1, y1, top), ...toWorld(meta, x0, y0, top));
        const nx2 = (y1 - y0) / len, ny2 = -(x1 - x0) / len; // outward normal in local x/y
        const nx = nx2, nz = -ny2; // world normal (world Z = -y)
        for (let n = 0; n < 4; n++) wn.push(nx, 0, nz);
        // Sample point per end: moved WALL_SAMPLE_INSET_M into the building (against the outward normal).
        const sx = -nx2 * WALL_SAMPLE_INSET_M, sy = -ny2 * WALL_SAMPLE_INSET_M;
        const a = [(x0 + sx) / W, 1 - (y0 + sy) / H], b = [(x1 + sx) / W, 1 - (y1 + sy) / H];
        wuv.push(...a, ...b, ...b, ...a); // same UV top and bottom: colour is constant up each wall
        wi.push(k, k + 1, k + 2, k, k + 2, k + 3);
      }
    }

    // Roof: triangulate outer ring with holes, then fix winding so every triangle faces up in world space.
    const flat = rings.flatMap((r) => r);
    const tris = THREE.ShapeUtils.triangulateShape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)), rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y))));
    const k0 = rp.length / 3;
    for (const [x, y] of flat) {
      rp.push(...toWorld(meta, x, y, top));
      rn.push(0, 1, 0);
      ruv.push(x / W, 1 - y / H);
    }
    for (const [a, b, c] of tris) {
      const [ax, ay] = flat[a], [bx, by] = flat[b], [cx, cy] = flat[c];
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
  return { walls: make(wp, wn, wuv, wi), roofs: make(rp, rn, ruv, ri) };
}

export function buildBuildings(meta, buildings, imageryTex) {
  const { walls, roofs } = buildBuildingGeometry(meta, buildings);
  const group = new THREE.Group(); group.name = 'buildings';
  const wallMesh = new THREE.Mesh(walls, new THREE.MeshLambertMaterial({ map: imageryTex, color: new THREE.Color().setRGB(WALL_BRIGHTNESS, WALL_BRIGHTNESS, WALL_BRIGHTNESS, THREE.SRGBColorSpace) }));
  const roofMesh = new THREE.Mesh(roofs, new THREE.MeshBasicMaterial({ map: imageryTex, side: THREE.DoubleSide }));
  wallMesh.name = 'walls'; roofMesh.name = 'roofs';
  group.add(wallMesh, roofMesh);
  return group;
}
