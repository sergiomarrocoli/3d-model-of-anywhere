import { describe, expect, it } from 'vitest';
import { HANDLES, MAX_AREA_M2, MAX_EDGE_M, MAX_SIZE_M, MIN_SIZE_M, boxBBox, boxCentre, boxSize, buildCommand, handlePosition, makeBox, moveBox, recentreBox, resizeBox } from '../box.js';

const b = makeBox([310950, 291380], 1000);

describe('box', () => {
  it('makeBox is square around the centre, clamped to the allowed size', () => {
    expect(boxBBox(b)).toEqual([310450, 290880, 311450, 291880]);
    expect(boxSize(makeBox([0, 0], 99999)).width).toBe(MAX_SIZE_M); expect(boxSize(makeBox([0, 0], 1)).width).toBe(MIN_SIZE_M);
    expect(boxCentre(b)).toEqual([310950, 291380]);
  });
  it('moveBox keeps the size', () => {
    const m = moveBox(b, 50, -30);
    expect(boxSize(m)).toEqual(boxSize(b)); expect(boxCentre(m)).toEqual([311000, 291350]);
  });
  it('recentreBox puts the centre at the point and keeps width and height (also for a rectangle)', () => {
    const r = recentreBox(b, [500000, 250000]);
    expect(boxCentre(r)).toEqual([500000, 250000]); expect(boxSize(r)).toEqual(boxSize(b));
    const rect = resizeBox(b, 'e', 311950, 0), r2 = recentreBox(rect, [1000, 2000]);
    expect(boxSize(r2)).toEqual({ width: 1500, height: 1000 }); expect(boxCentre(r2)).toEqual([1000, 2000]);
    expect(recentreBox(b, boxCentre(b))).toEqual(b);
  });
  it('handles sit on the corners, edge midpoints', () => {
    expect(handlePosition(b, 'ne')).toEqual([311450, 291880]); expect(handlePosition(b, 'sw')).toEqual([310450, 290880]);
    expect(handlePosition(b, 'n')).toEqual([310950, 291880]); expect(handlePosition(b, 'w')).toEqual([310450, 291380]);
    expect(HANDLES).toHaveLength(8);
  });
  it('a corner drag moves two edges and leaves the opposite corner fixed', () => {
    const r = resizeBox(b, 'ne', 311700, 292000);
    expect([r.minE, r.minN]).toEqual([b.minE, b.minN]); expect([r.maxE, r.maxN]).toEqual([311700, 292000]);
  });
  it('an edge drag moves one edge only', () => {
    const r = resizeBox(b, 'e', 311300, 999999);
    expect(r).toEqual({ ...b, maxE: 311300 });
    expect(resizeBox(b, 'n', 0, 291700)).toEqual({ ...b, maxN: 291700 });
    expect(resizeBox(b, 'w', 310300, 0)).toEqual({ ...b, minE: 310300 });
    expect(resizeBox(b, 's', 0, 290700)).toEqual({ ...b, minN: 290700 });
  });
  it('stops at the maximum size (2 km) however far the pointer goes, on every side', () => {
    const r = resizeBox(b, 'ne', 999999, 999999);
    expect(boxSize(r)).toEqual({ width: MAX_SIZE_M, height: MAX_SIZE_M }); expect([r.minE, r.minN]).toEqual([b.minE, b.minN]);
    const w = resizeBox(b, 'sw', -999999, -999999);
    expect(boxSize(w)).toEqual({ width: MAX_SIZE_M, height: MAX_SIZE_M }); expect([w.maxE, w.maxN]).toEqual([b.maxE, b.maxN]);
  });
  it('allows a long strip: 4 x 1 km, but not wider than 4 km', () => {
    const r = resizeBox(b, 'e', 999999, 0);
    expect(boxSize(r)).toEqual({ width: MAX_EDGE_M, height: 1000 }); expect([r.minE, r.minN, r.maxN]).toEqual([b.minE, b.minN, b.maxN]);
    const tall = resizeBox(b, 'n', 0, 999999);
    expect(boxSize(tall)).toEqual({ width: 1000, height: MAX_EDGE_M });
    const west = resizeBox(b, 'w', -999999, 0);
    expect(boxSize(west)).toEqual({ width: MAX_EDGE_M, height: 1000 }); expect(west.maxE).toBe(b.maxE);
  });
  it('an edge drag stops where the area runs out, and the other side cannot grow once the strip is that long', () => {
    const strip = resizeBox(b, 'e', 999999, 0), grown = resizeBox(strip, 'n', 0, 999999);
    expect(boxSize(grown)).toEqual({ width: MAX_EDGE_M, height: 1000 });
    const wide = resizeBox(b, 's', 0, -999999);                          // a 1 km wide box dragged down: height stops at 4 km
    expect(boxSize(wide).height).toBe(MAX_EDGE_M);
    const rect = resizeBox({ ...b, maxE: b.minE + 3000 }, 'n', 0, 999999);       // 3 km wide: height stops at 4 / 3 km
    expect(boxSize(rect).height).toBeCloseTo(MAX_AREA_M2 / 3000);
  });
  it('a corner drag past the limit scales both sides down together and keeps the opposite corner', () => {
    const r = resizeBox(b, 'ne', b.minE + 4000, b.minN + 2000);          // asked for 4 x 2 km = 8 km2
    const s = boxSize(r); expect(s.width * s.height).toBeCloseTo(MAX_AREA_M2); expect(s.width / s.height).toBeCloseTo(2);
    expect([r.minE, r.minN]).toEqual([b.minE, b.minN]);
    const sw = resizeBox(b, 'sw', b.maxE - 4000, b.maxN - 2000);
    expect(sw.maxE).toBe(b.maxE); expect(sw.maxN).toBe(b.maxN); expect(boxSize(sw).width * boxSize(sw).height).toBeCloseTo(MAX_AREA_M2);
  });
  it('whatever is dragged, wherever, the box stays inside the area, the edge and the minimum', () => {
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 400; i++) {
      const handle = HANDLES[Math.floor(rnd() * HANDLES.length)], start = resizeBox(b, 'ne', b.minE + 200 + rnd() * 1800, b.minN + 200 + rnd() * 1800);
      const r = resizeBox(start, handle, b.minE + (rnd() - 0.5) * 12000, b.minN + (rnd() - 0.5) * 12000), s = boxSize(r);
      expect(s.width * s.height).toBeLessThanOrEqual(MAX_AREA_M2 + 1e-6);
      expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(MAX_EDGE_M + 1e-6); expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(MIN_SIZE_M - 1e-6);
    }
  });
  it('stops at the minimum size and never flips inside out', () => {
    const r = resizeBox(b, 'ne', 0, 0);                       // dragged past the opposite corner
    expect(boxSize(r)).toEqual({ width: MIN_SIZE_M, height: MIN_SIZE_M });
    const l = resizeBox(b, 'w', 999999, 0);
    expect(l.maxE - l.minE).toBe(MIN_SIZE_M); expect(l.maxE).toBe(b.maxE);
  });
  it('allows a rectangle: width and height are independent', () => {
    const r = resizeBox(b, 'e', 311950, 0);
    expect(boxSize(r)).toEqual({ width: 1500, height: 1000 });
  });
  it('buildCommand gives the pipeline command with whole metres', () => {
    expect(buildCommand(b, 'newtown')).toBe('python3 -m pipeline.build_area --bbox 310450 290880 311450 291880 --id newtown');
    expect(buildCommand({ minE: 1.4, minN: 2.6, maxE: 10.5, maxN: 20.2 })).toContain('--bbox 1 3 11 20');
  });
});
