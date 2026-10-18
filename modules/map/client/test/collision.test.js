import { describe, it, expect } from 'vitest';
import { buildCollisionGrid, resolveCircle, insideBuilding, buildingsNear, insideRubble, removeBuilding, restoreBuildings, buildingEntry } from '../collision.js';

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

describe('destroyed buildings', () => {
  const grid = () => buildCollisionGrid({ features: [{ geometry: { type: 'Point', coordinates: [0, 0] } }, { geometry: { type: 'Polygon', coordinates: [sq(10, 10, 20, 20)] } }, { geometry: { type: 'Polygon', coordinates: [sq(40, 10, 50, 20)] } }] });
  it('ids are the building\'s place in the feature list, whatever came before it', () => {
    const g = grid(); expect(g.polys.map((p) => p.id)).toEqual([1, 2]); expect(buildingEntry(g, 2).minX).toBe(40); expect(buildingEntry(g, 0)).toBeUndefined();
  });
  it('finds the standing buildings near a point, nearest first, with the distance to the wall', () => {
    const g = grid(), near = buildingsNear(g, 15, 15, 40);
    expect(near.map((n) => n.id)).toEqual([1, 2]); expect(near[0].d).toBe(0);                    // inside the first
    expect(near[1].d).toBeCloseTo(25);                                                            // 25 m from the second's wall
    expect(buildingsNear(g, 15, 15, 10).map((n) => n.id)).toEqual([1]); expect(buildingsNear(g, 100, 100, 10)).toEqual([]);
    expect(buildingsNear(g, 25, 15, 6)[0]).toEqual({ id: 1, d: 5 });
  });
  it('a removed building no longer blocks anything, is found as rubble instead, and can be put back', () => {
    const g = grid(); expect(insideBuilding(g, 15, 15)).toBe(true); expect(insideRubble(g, 15, 15)).toBe(false);
    expect(removeBuilding(g, 1)).toBe(true); expect(removeBuilding(g, 1)).toBe(false);              // only once
    expect(insideBuilding(g, 15, 15)).toBe(false); expect(insideRubble(g, 15, 15)).toBe(true); expect(insideRubble(g, 45, 15)).toBe(false);
    expect(resolveCircle(g, 9.8, 15, R)).toEqual({ x: 9.8, y: 15 });                                  // walk straight through where the wall was
    expect(buildingsNear(g, 15, 15, 5)).toEqual([]);
    expect(insideBuilding(g, 45, 15)).toBe(true);                                                     // the other building is untouched
    restoreBuildings(g); expect(insideBuilding(g, 15, 15)).toBe(true); expect(insideRubble(g, 15, 15)).toBe(false);
  });
});
