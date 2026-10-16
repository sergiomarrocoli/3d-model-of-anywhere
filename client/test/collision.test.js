import { describe, it, expect } from 'vitest';
import { buildCollisionGrid, resolveCircle, insideBuilding } from '../src/collision.js';

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = (...polys) => ({ features: polys.map((coordinates) => ({ geometry: { type: 'Polygon', coordinates: [coordinates] } })) });
const R = 0.5;

describe('collision', () => {
  const grid = buildCollisionGrid(fc(sq(10, 10, 20, 20)));
  it('leaves a free circle alone', () => {
    expect(resolveCircle(grid, 5, 5, R)).toEqual({ x: 5, y: 5 });
    expect(resolveCircle(grid, 9.4, 15, R)).toEqual({ x: 9.4, y: 15 });
  });
  it('pushes a circle overlapping a wall back to exactly r from it', () => {
    const p = resolveCircle(grid, 9.8, 15, R);
    expect(p.x).toBeCloseTo(9.5); expect(p.y).toBeCloseTo(15);
  });
  it('slides along a wall: tangential motion is kept', () => {
    const p = resolveCircle(grid, 9.7, 17, R);
    expect(p.y).toBeCloseTo(17); expect(p.x).toBeCloseTo(9.5);
  });
  it('ejects a circle that ended up inside, via the nearest edge', () => {
    const p = resolveCircle(grid, 12, 15, R);
    expect(p.x).toBeCloseTo(9.5); expect(p.y).toBeCloseTo(15);
    expect(insideBuilding(grid, 15, 15)).toBe(true);
    expect(insideBuilding(grid, 5, 5)).toBe(false);
  });
  it('rounds a convex corner at distance r', () => {
    const p = resolveCircle(grid, 9.8, 9.8, R);
    expect(Math.hypot(p.x - 10, p.y - 10)).toBeCloseTo(R);
  });
  it('treats courtyard holes as walkable and their walls as solid', () => {
    const g = buildCollisionGrid({ features: [{ geometry: { type: 'Polygon', coordinates: [sq(0, 0, 30, 30), sq(10, 10, 20, 20)] } }] });
    expect(insideBuilding(g, 15, 15)).toBe(false);
    expect(insideBuilding(g, 5, 5)).toBe(true);
    expect(resolveCircle(g, 15, 15, R)).toEqual({ x: 15, y: 15 });
    const p = resolveCircle(g, 10.2, 15, R); // inside the hole, touching its wall: pushed back into the courtyard
    expect(p.x).toBeCloseTo(10.5);
  });
  it('indexes many buildings and only checks neighbours', () => {
    const many = buildCollisionGrid(fc(...Array.from({ length: 2000 }, (_, i) => sq((i % 50) * 20, Math.floor(i / 50) * 20, (i % 50) * 20 + 10, Math.floor(i / 50) * 20 + 10))));
    const t = performance.now();
    for (let i = 0; i < 10000; i++) resolveCircle(many, 15 + (i % 900), 15 + ((i * 7) % 700), R);
    expect(performance.now() - t).toBeLessThan(500);
    expect(resolveCircle(many, 15, 15, R)).toEqual({ x: 15, y: 15 }); // in the gap between blocks
  });
});
