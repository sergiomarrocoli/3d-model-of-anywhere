import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBuildingGeometry, buildBuildings, WALL_BRIGHTNESS, WALL_SAMPLE_INSET_M } from '../buildings.js';

const meta = { size_m: [100, 100], heightmap: { min: 10 } };
const fc = (...features) => ({ type: 'FeatureCollection', features });
const poly = (rings, props = { base_z: 12, height: 8 }) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: rings } });
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];                 // CCW
const sqCW = (x0, y0, x1, y1) => sq(x0, y0, x1, y1).reverse();

const tris = (g) => { const p = g.getAttribute('position'), idx = g.index.array, out = []; for (let i = 0; i < idx.length; i += 3) out.push([0, 1, 2].map((k) => [p.getX(idx[i + k]), p.getY(idx[i + k]), p.getZ(idx[i + k])])); return out; };
const faceNormal = ([a, b, c]) => { const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]); return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; };
const area = (t) => Math.hypot(...faceNormal(t)) / 2;

for (const [name, ring] of [['CCW', sq(10, 20, 30, 40)], ['CW', sqCW(10, 20, 30, 40)]]) {
  describe(`square building (${name} input)`, () => {
    const { walls, roofs } = buildBuildingGeometry(meta, fc(poly([ring])));
    it('has 4 wall quads and a 2-triangle roof', () => { expect(tris(walls)).toHaveLength(8); expect(tris(roofs)).toHaveLength(2); });
    it('puts the roof at base_z + height (relative to the lowest terrain) and walls between base and roof', () => {
      const ys = [...roofs.getAttribute('position').array].filter((_, i) => i % 3 === 1);
      expect(new Set(ys)).toEqual(new Set([10]));   // 12 + 8 - 10
      const wy = [...walls.getAttribute('position').array].filter((_, i) => i % 3 === 1);
      expect(Math.min(...wy)).toBe(2); expect(Math.max(...wy)).toBe(10);
    });
    it('roof triangles face up and cover the footprint', () => {
      const t = tris(roofs);
      for (const tr of t) expect(faceNormal(tr)[1]).toBeGreaterThan(0);
      expect(t.reduce((s, tr) => s + area(tr), 0)).toBeCloseTo(400);
    });
    it('wall triangles face outward, matching their stored normals', () => {
      const centre = [20, 0, -30]; // world position of footprint centre
      const nAttr = walls.getAttribute('normal'), idx = walls.index.array;
      tris(walls).forEach((tr, i) => {
        const fn = faceNormal(tr), mid = [0, 1, 2].map((k) => (tr[0][k] + tr[1][k] + tr[2][k]) / 3);
        const stored = [nAttr.getX(idx[i * 3]), nAttr.getY(idx[i * 3]), nAttr.getZ(idx[i * 3])];
        expect(fn[0] * stored[0] + fn[1] * stored[1] + fn[2] * stored[2]).toBeGreaterThan(0);          // winding agrees with the normal
        expect(stored[0] * (mid[0] - centre[0]) + stored[2] * (mid[2] - centre[2])).toBeGreaterThan(0); // and it points away from the centre
      });
    });
    it('colours walls from the imagery just inside the footprint edge, constant up each wall', () => {
      const uv = walls.getAttribute('uv'), p = walls.getAttribute('position');
      for (let q = 0; q < 4; q++) {
        const k = q * 4;
        expect([uv.getX(k), uv.getY(k)]).toEqual([uv.getX(k + 3), uv.getY(k + 3)]);     // top == bottom at each end
        expect([uv.getX(k + 1), uv.getY(k + 1)]).toEqual([uv.getX(k + 2), uv.getY(k + 2)]);
        for (const c of [0, 1]) { // bottom corners: world (x, _, -y)
          const cx = p.getX(k + c), cy = -p.getZ(k + c);
          const dx = uv.getX(k + c) * 100 - cx, dy = (1 - uv.getY(k + c)) * 100 - cy;
          expect(Math.hypot(dx, dy)).toBeCloseTo(WALL_SAMPLE_INSET_M, 3);                // 0.75 m from the corner...
          expect(dx * (20 - cx) + dy * (30 - cy)).toBeGreaterThan(0);                     // ...towards the footprint centre (20, 30)
        }
      }
    });
    it('gives roofs planar imagery UVs', () => {
      const ru = roofs.getAttribute('uv'), rp = roofs.getAttribute('position');
      for (let i = 0; i < rp.count; i++) { // u = x / width, v = 1 - y / height, with world x = x and world z = -y
        expect(ru.getX(i)).toBeCloseTo(rp.getX(i) / 100); expect(ru.getY(i)).toBeCloseTo(1 + rp.getZ(i) / 100);
      }
    });
  });
}

describe('courtyard building', () => {
  const { walls, roofs } = buildBuildingGeometry(meta, fc(poly([sq(0, 0, 20, 20), sq(5, 5, 15, 15)])));
  it('leaves the hole open on the roof and walls the inside', () => {
    expect(tris(roofs).reduce((s, tr) => s + area(tr), 0)).toBeCloseTo(400 - 100);
    expect(tris(walls)).toHaveLength(16);
  });
  it('inner walls face into the courtyard', () => {
    const n = walls.getAttribute('normal'); const centre = [10, -10];
    for (let q = 4; q < 8; q++) { // quads 4-7 belong to the hole
      const k = q * 4, mx = (walls.getAttribute('position').getX(k) + walls.getAttribute('position').getX(k + 1)) / 2, mz = (walls.getAttribute('position').getZ(k) + walls.getAttribute('position').getZ(k + 1)) / 2;
      expect(n.getX(k) * (centre[0] - mx) + n.getZ(k) * (centre[1] - mz)).toBeGreaterThan(0);
    }
  });
});

describe('robustness', () => {
  it('uses defaults for missing height/base and skips non-polygons and degenerate rings', () => {
    const { walls, roofs } = buildBuildingGeometry(meta, fc(
      poly([sq(0, 0, 4, 4)], {}),
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
      poly([[[0, 0], [1, 1], [0, 0]]]),
    ));
    expect(tris(walls)).toHaveLength(8);
    expect(Math.max(...[...roofs.getAttribute('position').array].filter((_, i) => i % 3 === 1))).toBe(6); // base = terrain min (10) + 6 - 10 ... = 6
  });
  it('handles an empty collection', () => {
    const { walls, roofs } = buildBuildingGeometry(meta, fc());
    expect(walls.index.count).toBe(0); expect(roofs.index.count).toBe(0);
  });
});

describe('wall brightness', () => {
  it('multiplies the copied imagery by a 75% sRGB grey on walls only', () => {
    const tex = new THREE.Texture();
    const group = buildBuildings(meta, fc(poly([sq(0, 0, 4, 4)])), tex);
    const walls = group.getObjectByName('walls'), roofs = group.getObjectByName('roofs');
    expect(WALL_BRIGHTNESS).toBe(0.75);
    expect(walls.material.map).toBe(tex);
    const { r, g, b } = walls.material.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    expect([r, g, b].map((v) => +v.toFixed(3))).toEqual([0.75, 0.75, 0.75]);
    expect(roofs.material.color.getHex()).toBe(0xffffff); // roofs untouched
  });
});

describe('pitched roofs from a surface map', () => {
  // 100x100 m, 1 m cells, absolute elevations. A gable running east-west over y 20..40 (ridge at y = 30):
  // eaves at 20 m, ridge at 26 m, ground elsewhere at 12 m.
  const n = 100, data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const y = n - r - 0.5, x = c + 0.5;
    data[r * n + c] = x >= 10 && x <= 50 && y >= 20 && y <= 40 ? 26 - 6 * (Math.abs(y - 30) / 10) : 12;
  }
  const surface = { width: n, height: n, resolution: 1, data };
  const house = poly([sq(10, 20, 50, 40)], { base_z: 12, height: 10 });
  const { walls, roofs } = buildBuildingGeometry(meta, fc(house), surface);
  const ys = (g) => [...g.getAttribute('position').array].filter((_, i) => i % 3 === 1);

  it('follows the ridge: highest in the middle, eaves lower, floored above the base', () => {
    const p = roofs.getAttribute('position');
    let ridge = -Infinity, eave = Infinity;
    for (let i = 0; i < p.count; i++) {
      const y = -p.getZ(i); // local y
      if (Math.abs(y - 30) < 0.01) ridge = Math.max(ridge, p.getY(i));
      if (Math.abs(y - 20) < 0.01 || Math.abs(y - 40) < 0.01) eave = Math.min(eave, p.getY(i));
    }
    expect(ridge).toBeCloseTo(26 - 10, 0);   // minus zRef 10
    expect(eave).toBeLessThan(ridge - 3);
    expect(Math.min(...ys(roofs))).toBeGreaterThanOrEqual(2 - 1e-6 + 0); // base 12 + 2 - zRef 10
  });
  it('is a clean gable: a few big flat faces with a straight ridge along the full length, covering the footprint and facing up', () => {
    const t = tris(roofs);
    expect(t.length).toBeLessThan(20);
    const ridgeXs = t.flat().filter(([, , z]) => Math.abs(-z - 30) < 1e-6).map(([x]) => +x.toFixed(3));
    expect(Math.min(...ridgeXs)).toBeCloseTo(10); expect(Math.max(...ridgeXs)).toBeCloseTo(50);      // the ridge runs the full 40 m, end to end
    expect(t.reduce((s, tr) => s + area(tr), 0)).toBeGreaterThan(40 * 20 - 1e-6);   // pitched, so slightly more than the plan area
    const plan = (tr) => { const [a, b, c] = tr; return Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2; };
    expect(t.reduce((s, tr) => s + plan(tr), 0)).toBeCloseTo(800, 3);
    for (const tr of t) expect(faceNormal(tr)[1]).toBeGreaterThan(0);
  });
  it('has no cracks: every wall top point is a roof vertex at the same height', () => {
    const rp = roofs.getAttribute('position'), wp = walls.getAttribute('position');
    const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const roofPts = new Set(); for (let i = 0; i < rp.count; i++) roofPts.add(key(rp.getX(i), rp.getY(i), rp.getZ(i)));
    let tops = 0;
    for (let q = 0; q < wp.count; q += 4) for (const c of [2, 3]) { tops++; expect(roofPts.has(key(wp.getX(q + c), wp.getY(q + c), wp.getZ(q + c)))).toBe(true); }
    expect(tops).toBeGreaterThanOrEqual(12);                                       // the two gable ends are each split at the ridge
  });
  it('the gable ends are walled up to the ridge in a triangle, the long walls stop level at the eaves', () => {
    const wp = walls.getAttribute('position'), top = [];
    for (let q = 0; q < wp.count; q += 4) top.push({ y: [wp.getY(q + 2), wp.getY(q + 3)], z: [wp.getZ(q + 2), wp.getZ(q + 3)], x: [wp.getX(q + 2), wp.getX(q + 3)] });
    const apex = top.filter((w) => Math.abs(Math.max(...w.y) - 16) < 0.01); expect(apex.length).toBeGreaterThan(0);        // some wall piece reaches the ridge height (26 - 10)
    const eaves = top.filter((w) => Math.abs(w.z[0] + 20) < 0.01 && Math.abs(w.z[1] + 20) < 0.01 || Math.abs(w.z[0] + 40) < 0.01 && Math.abs(w.z[1] + 40) < 0.01);
    expect(eaves.length).toBe(2); for (const w of eaves) expect(w.y[0]).toBeCloseTo(w.y[1], 3);                                // each long wall has one level top
  });
  it('no surface: unchanged flat roof', () => {
    const flat = buildBuildingGeometry(meta, fc(house)).roofs;
    expect(new Set(ys(flat))).toEqual(new Set([12])); expect(tris(flat)).toHaveLength(2);
  });
  it('caps tree-like spikes and keeps footprints on a gap in the data', () => {
    const spike = { ...surface, data: data.map((v, i) => (i % 7 === 0 ? 200 : v)) };
    const cap = 12 + 2 * 10 + 2 - 10; // base + 2h + 2 - zRef
    expect(Math.max(...ys(buildBuildingGeometry(meta, fc(house), spike).roofs))).toBeLessThanOrEqual(cap + 1e-6);
  });
});


describe('wall patchwork texture', () => {
  const g = buildBuildingGeometry(meta, fc(poly([sq(10, 20, 30, 40)])));
  it('gives walls metres-along and elevation attributes, continuous along a wall', () => {
    const t = g.walls.getAttribute('wallDetail'), p = g.walls.getAttribute('position');
    expect(t.count).toBe(p.count);
    const k = 0; // first wall quad: bottom0, bottom1, top1, top0
    expect(t.getY(k + 2) - t.getY(k)).toBeCloseTo(8, 3);            // 8 m tall wall
    expect(t.getX(k + 1) - t.getX(k)).toBeCloseTo(20, 3);           // 20 m wall along the edge
    expect(t.getX(k + 3)).toBeCloseTo(t.getX(k)); expect(t.getX(k + 2)).toBeCloseTo(t.getX(k + 1));
  });
  it('every vertex of a wall carries the imagery UVs of the whole edge (inset into the building), not just its piece', () => {
    const e = g.walls.getAttribute('wallEdge'), uv = g.walls.getAttribute('uv');
    for (let q = 0; q < 4; q++) {
      const k = q * 4;
      for (let c = 0; c < 4; c++) for (let m = 0; m < 4; m++) expect(e.getX(k + c) === e.getX(k + m) && e.getW(k + c) === e.getW(k + m)).toBe(true);
      expect(e.getX(k)).toBeCloseTo(uv.getX(k)); expect(e.getY(k)).toBeCloseTo(uv.getY(k));       // start of edge = sample point of the first corner
      expect(e.getZ(k)).toBeCloseTo(uv.getX(k + 1)); expect(e.getW(k)).toBeCloseTo(uv.getY(k + 1)); // end of edge
    }
  });
  it('a long wall split into pieces (pitched roofs) still samples the whole edge', () => {
    const n = 100, data = new Float32Array(n * n);                                  // a hip roof, which is built on a fine grid
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = c + 0.5, y = n - r - 0.5, d = Math.min(x - 10, 50 - x, y - 20, 40 - y); data[r * n + c] = d < 0 ? 12 : 20 + Math.min(1, d / 10) * 5; }
    const surface = { width: n, height: n, resolution: 1, data };
    const w = buildBuildingGeometry(meta, fc(poly([sq(10, 20, 50, 40)], { base_z: 12, height: 8 })), surface).walls;
    const e = w.getAttribute('wallEdge'), t = w.getAttribute('wallDetail');
    expect(w.getAttribute('position').count).toBeGreaterThan(16);                    // split into more than 4 quads
    const xs = new Set(); for (let i = 0; i < e.count; i++) xs.add(`${e.getX(i).toFixed(4)},${e.getY(i).toFixed(4)},${e.getZ(i).toFixed(4)},${e.getW(i).toFixed(4)}`);
    expect(xs.size).toBe(4);                                                         // one (start,end) pair per wall
    let maxAlong = 0; for (let i = 0; i < t.count; i++) maxAlong = Math.max(maxAlong, t.getX(i)); expect(maxAlong).toBeCloseTo(40, 3);
  });
  it('buildBuildings still produces walls and roofs', () => {
    const grp = buildBuildings(meta, fc(poly([sq(10, 20, 30, 40)])), new THREE.Texture());
    expect(grp.children.map((c) => c.name)).toEqual(['walls', 'roofs']);
  });
});
