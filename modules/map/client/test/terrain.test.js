import { describe, expect, it } from 'vitest';
import { sampleHeight } from '../heightmap.js';
import { buildTerrainGeometry } from '../terrain.js';
import { toWorld } from '../coords.js';

// 4x4 m box, 1 m cells. Elevation = 10 + col (rises to the east) + 100 * (north-ness): row 0 is north.
const W = 4, H = 4;
const data = new Float32Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) data[r * W + c] = 10 + c + 100 * (H - 1 - r);
const hm = { width: W, height: H, resolution: 1, data };
const meta = { size_m: [W, H], heightmap: { min: 10 } };

describe('sampleHeight', () => {
  it('returns the cell value at a pixel centre, with row 0 at the north edge', () => {
    expect(sampleHeight(hm, 0.5, 0.5)).toBe(10);        // SW cell (south = last row)
    expect(sampleHeight(hm, 3.5, 3.5)).toBe(13 + 300);  // NE cell
  });
  it('interpolates bilinearly between centres and clamps outside', () => {
    expect(sampleHeight(hm, 1.0, 0.5)).toBeCloseTo(10.5);
    expect(sampleHeight(hm, 1.0, 1.0)).toBeCloseTo(10.5 + 50);
    expect(sampleHeight(hm, 0, 0)).toBe(10); expect(sampleHeight(hm, 99, 99)).toBe(313);
  });
});

describe('buildTerrainGeometry', () => {
  const g = buildTerrainGeometry(meta, hm);
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  const vert = (i, j) => { const k = j * (W + 1) + i; return [p.getX(k), p.getY(k), p.getZ(k), uv.getX(k), uv.getY(k)]; };

  it('has (size+1)^2 vertices and 2 triangles per cell', () => {
    expect(p.count).toBe(25); expect(g.index.count).toBe(W * H * 6);
  });
  it('puts the SW corner at the origin and the NE corner at x=W, z=-H (north is -Z)', () => {
    expect(vert(0, 0).slice(0, 3)).toEqual([0, 0, -0]);
    const ne = vert(W, H);
    expect(ne[0]).toBe(W); expect(ne[2]).toBe(-H); expect(ne[1]).toBe(313 - 10);
  });
  it('maps the imagery: SW = bottom-left of the picture, NE = top-right', () => {
    expect(vert(0, 0).slice(3)).toEqual([0, 1]);
    expect(vert(W, H).slice(3)).toEqual([1, 0]);
  });
  it('faces up', () => {
    const flat = buildTerrainGeometry(meta, { ...hm, data: new Float32Array(W * H).fill(10) });
    const n = flat.getAttribute('normal');
    for (let k = 0; k < n.count; k++) expect(n.getY(k)).toBeCloseTo(1);
  });
});

describe('toWorld', () => {
  it('is Y-up with north = -Z and elevation relative to the lowest terrain', () => {
    expect(toWorld(meta, 3, 4, 15)).toEqual([3, 5, -4]);
  });
});
