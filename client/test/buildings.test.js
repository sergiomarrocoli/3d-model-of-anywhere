import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBuildingGeometry, buildBuildings, WALL_BRIGHTNESS, WALL_SAMPLE_INSET_M } from '../src/buildings.js';

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
  it('multiplies the copied imagery by a 25% sRGB grey on walls only', () => {
    const tex = new THREE.Texture();
    const group = buildBuildings(meta, fc(poly([sq(0, 0, 4, 4)])), tex);
    const walls = group.getObjectByName('walls'), roofs = group.getObjectByName('roofs');
    expect(WALL_BRIGHTNESS).toBe(0.25);
    expect(walls.material.map).toBe(tex);
    const { r, g, b } = walls.material.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    expect([r, g, b].map((v) => +v.toFixed(3))).toEqual([0.25, 0.25, 0.25]);
    expect(roofs.material.color.getHex()).toBe(0xffffff); // roofs untouched
  });
});
