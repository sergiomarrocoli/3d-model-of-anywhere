import { describe, expect, it } from 'vitest';
import { HANDLES, MAX_SIZE_M, MIN_SIZE_M, boxBBox, boxCentre, boxSize, buildCommand, handlePosition, makeBox, moveBox, resizeBox } from '../box.js';

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
