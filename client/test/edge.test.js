import { describe, it, expect } from 'vitest';
import { edgeFactor, clampToBox, EDGE_FADE_M } from '../src/edge.js';

const W = 1000, H = 800; // world X 0..W, world Z -H..0
describe('edge', () => {
  it('is 0 on every edge, 1 well inside, and rises monotonically', () => {
    for (const [x, z] of [[0, -400], [W, -400], [500, 0], [500, -H]]) expect(edgeFactor(x, z, W, H)).toBe(0);
    expect(edgeFactor(500, -400, W, H)).toBe(1);
    expect(edgeFactor(EDGE_FADE_M, -400, W, H)).toBe(1);
    let prev = -1; for (let x = 0; x <= EDGE_FADE_M; x += 3) { const f = edgeFactor(x, -400, W, H); expect(f).toBeGreaterThanOrEqual(prev); prev = f; }
  });
  it('uses the nearest edge, and is 0 outside', () => {
    expect(edgeFactor(15, -15, W, H)).toBeCloseTo(0.5);
    expect(edgeFactor(-5, -400, W, H)).toBe(0);
  });
  it('clamps positions inside by the margin and leaves interior ones alone', () => {
    expect(clampToBox(-10, 10, W, H, 5)).toEqual({ x: 5, z: -5 });
    expect(clampToBox(2000, -2000, W, H, 5)).toEqual({ x: 995, z: -795 });
    expect(clampToBox(300, -300, W, H, 5)).toEqual({ x: 300, z: -300 });
  });
});
