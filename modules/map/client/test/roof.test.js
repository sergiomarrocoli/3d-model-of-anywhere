import { describe, expect, it } from 'vitest';
import { dominantAngle, fitRoof, inside } from '../roof.js';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];                          // CCW
const dist = (rings) => (x, y) => { let d = Infinity; for (const r of rings) for (let i = 0; i < r.length; i++) { const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy)); } return d; };
// a deterministic pseudo-noise so the tests do not depend on Math.random
const noise = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v) - 0.5; };
const fit = (ring, surface) => fitRoof([ring], surface, dist([ring]));

describe('inside and dominantAngle', () => {
  it('knows inside from outside, holes included', () => {
    const rings = [rect(0, 0, 20, 20), rect(5, 5, 15, 15).reverse()];
    expect(inside(rings, 2, 2)).toBe(true); expect(inside(rings, 10, 10)).toBe(false); expect(inside(rings, 30, 3)).toBe(false);
  });
  it('is the direction the walls run in, whichever way round the edges are listed', () => {
    const t = 0.4, ring = rect(0, 0, 30, 10).map(([x, y]) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)]);
    const a = dominantAngle(ring), off = ((a - t) * 2 / Math.PI); expect(Math.abs(off - Math.round(off))).toBeLessThan(0.01);   // equal mod a quarter turn
  });
});

describe('fitRoof', () => {
  const house = rect(10, 20, 50, 40);                                  // 40 x 20: a ridge along x at y = 30 when it is a gable
  it('finds a gable in noisy data: eaves, ridge height and ridge position, ridge across the shorter side', () => {
    const r = fit(house, (x, y) => 20 + 6 * (1 - Math.abs(y - 30) / 10) + noise(x, y) * 0.6);
    expect(r.kind).toBe('gable'); expect(r.eave).toBeCloseTo(20, 0); expect(r.peak).toBeCloseTo(26, 0);
    expect(r.z(30, 30)).toBeCloseTo(r.peak, 3); expect(r.z(30, 20)).toBeCloseTo(r.eave, 3); expect(r.z(30, 30)).toBeGreaterThan(r.z(30, 25));
    expect(r.creases).toHaveLength(1); expect(Math.abs(r.creases[0](30, 30))).toBeLessThan(0.3);                                  // the crease is the ridge
    expect(r.z(12, 30)).toBeCloseTo(r.z(48, 30), 3);                                                                              // level along the ridge
  });
  it('finds a hip: slopes on all four sides, a short ridge, fine faces for the diagonals', () => {
    const r = fit(house, (x, y) => 20 + Math.min(6, 0.6 * Math.min(x - 10, 50 - x, y - 20, 40 - y)) + noise(y, x) * 0.5);
    expect(r.kind).toBe('hip'); expect(r.maxLen).toBeLessThanOrEqual(1);
    expect(r.z(30, 30)).toBeCloseTo(r.peak, 1); expect(r.z(12, 30)).toBeLessThan(r.z(20, 30)); expect(r.z(30, 22)).toBeLessThan(r.z(30, 27));
  });
  it('makes a bumpy roof with chimneys and a tree flat, at the middle height', () => {
    const r = fit(house, (x, y) => 22 + noise(x, y) * 0.5 + (Math.hypot(x - 20, y - 25) < 1.5 ? 2.5 : 0) + (x > 46 ? 3 : 0));
    expect(r.kind).toBe('flat'); expect(r.z(15, 25)).toBeCloseTo(22, 0); expect(r.z(40, 35)).toBe(r.z(15, 25));
  });
  it('finds a single slope (shed) when the roof is one tilted plane', () => {
    const r = fit(house, (x, y) => 20 + 0.3 * (y - 20) + noise(x, y) * 0.2);
    expect(r.kind).toBe('shed'); expect(r.z(30, 38)).toBeGreaterThan(r.z(30, 22) + 3); expect(r.z(20, 30)).toBeCloseTo(r.z(45, 30), 1);
  });
  it('does not let a thin tall strip (a tree overhanging one end) make a spike', () => {
    const r = fit(house, (x, y) => 20 + 6 * (1 - Math.abs(y - 30) / 10) + (x < 11.5 && y > 28 && y < 32 ? 15 : 0));
    expect(r.kind).toBe('gable'); expect(r.peak).toBeLessThan(28);
  });
  it('caps the pitch, so a deep narrow pit of noise cannot make a needle', () => {
    const r = fit(rect(0, 0, 20, 4), (x, y) => 10 + 30 * (1 - Math.abs(y - 2) / 2)); expect(r.peak - r.eave).toBeLessThanOrEqual(1.2 * 4 + 1e-9);                       // never steeper than about 50 degrees across the 4 m width
  });
  it('works on a building turned to any angle, and on one with a courtyard', () => {
    const t = 0.6, rot = ([x, y]) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)], ring = house.map(rot);
    const r = fit(ring, (x, y) => { const lx = x * Math.cos(t) + y * Math.sin(t), ly = -x * Math.sin(t) + y * Math.cos(t); return 20 + 6 * (1 - Math.abs(ly - 30) / 10) + 0 * lx; });
    expect(r.kind).toBe('gable'); expect(r.peak).toBeCloseTo(26, 0);
    const rings = [rect(0, 0, 30, 30), rect(10, 10, 20, 20).reverse()], c = fitRoof(rings, () => 15, dist(rings)); expect(c.kind).toBe('flat');
  });
  it('says nothing when there is almost no data (a tiny shed)', () => { expect(fit(rect(0, 0, 2, 2), () => 5)).toBeNull(); });
});
