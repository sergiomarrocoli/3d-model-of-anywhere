import { describe, expect, it } from 'vitest';
import { GB_EXTENT, fromBNG, insideGB, toBNG } from '../bng.js';

// Reference values from pyproj (exact OSTN15-free Helmert chain used by the pipeline): E/N <-> lon/lat.
const REF = [
  [310950, 291380, -3.3136227509059846, 52.51300669191204],   // Newtown, Powys
  [375250, 164750, -2.35701715974165, 51.38125423345635],     // Bath
  [530000, 180000, -0.12835394047946935, 51.50399082763378],  // London
  [325000, 675000, -3.2029433032337185, 55.962132576224846],  // Edinburgh
];
const metresApart = ([e1, n1], [e2, n2]) => Math.hypot(e1 - e2, n1 - n2);

describe('bng', () => {
  it('converts lon/lat to grid within a few metres of pyproj', () => {
    for (const [e, n, lon, lat] of REF) expect(metresApart(toBNG(lon, lat), [e, n])).toBeLessThan(10);
  });
  it('and back, and round-trips', () => {
    for (const [e, n, lon, lat] of REF) {
      const [lo, la] = fromBNG(e, n);
      expect(Math.abs(lo - lon) * 68000).toBeLessThan(10); expect(Math.abs(la - lat) * 111000).toBeLessThan(10);   // degrees -> metres at ~52 N
      expect(metresApart(toBNG(lo, la), [e, n])).toBeLessThan(0.01);
    }
  });
  it('insideGB checks the grid extent', () => {
    expect(insideGB([310450, 290880, 311450, 291880])).toBe(true);
    expect(insideGB([-10, 0, 990, 1000])).toBe(false);
    expect(insideGB([699500, 1299500, 700500, 1300500])).toBe(false);
    expect(GB_EXTENT.maxE).toBe(700000);
    const [e] = toBNG(2.35, 48.85);   // Paris
    expect(e).toBeGreaterThan(700000);
  });
});
