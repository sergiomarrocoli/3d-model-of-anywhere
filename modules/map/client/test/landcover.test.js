import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { SURFACE, SURFACE_NAMES, decodeLandcover, landcoverPixels, surfaceIdAt, surfaceInfo } from '../landcover.js';

const png8 = (data, width, height) => encode({ width, height, data: Uint8Array.from(data), depth: 8, channels: 1 });
// 4 x 2 cells at 0.5 m (a 2 m x 1 m box). Top row is the north edge: road road grass water; bottom row: tree tree paved building.
const lc = (over = {}) => ({ width: 4, height: 2, resolution: 0.5, data: Uint8Array.from([1, 1, 3, 6, 5, 5, 2, 7]), ...over });

describe('decodeLandcover', () => {
  const meta = { width: 4, height: 2, resolution_m: 0.5 };
  it('reads class ids row by row', () => {
    const out = decodeLandcover(png8([1, 1, 3, 6, 5, 5, 2, 7], 4, 2), meta);
    expect([...out.data]).toEqual([1, 1, 3, 6, 5, 5, 2, 7]); expect(out.resolution).toBe(0.5);
  });
  it('rejects the wrong size and 16-bit input', () => {
    expect(() => decodeLandcover(png8([0, 0, 0, 0], 2, 2), meta)).toThrow(/meta says/);
    const png16 = encode({ width: 4, height: 2, data: new Uint16Array(8), depth: 16, channels: 1 });
    expect(() => decodeLandcover(png16, meta)).toThrow(/8-bit/);
  });
});

describe('surfaceIdAt', () => {
  it('uses local metres: x east, y north, with the first row at the north edge', () => {
    expect(surfaceIdAt(lc(), 0.1, 0.9)).toBe(SURFACE.ROAD);      // north-west cell
    expect(surfaceIdAt(lc(), 1.9, 0.9)).toBe(SURFACE.WATER);     // north-east
    expect(surfaceIdAt(lc(), 0.1, 0.1)).toBe(SURFACE.TREE);      // south-west
    expect(surfaceIdAt(lc(), 1.9, 0.1)).toBe(SURFACE.BUILDING);  // south-east
  });
  it('uses the edge cell outside the box and UNKNOWN with no layer', () => {
    expect(surfaceIdAt(lc(), -5, 50)).toBe(SURFACE.ROAD); expect(surfaceIdAt(lc(), 99, -3)).toBe(SURFACE.BUILDING);
    expect(surfaceIdAt(null, 1, 1)).toBe(SURFACE.UNKNOWN);
  });
});

describe('surfaceInfo and the palette', () => {
  it('names every class, always with the same frozen object, and treats the unexpected as unknown', () => {
    expect(SURFACE_NAMES[SURFACE.WATER]).toBe('water'); expect(surfaceInfo(6)).toEqual({ id: 6, name: 'water' });
    expect(surfaceInfo(6)).toBe(surfaceInfo(6)); expect(Object.isFrozen(surfaceInfo(6))).toBe(true);
    expect(surfaceInfo(99)).toEqual({ id: 0, name: 'unknown' });
  });
  it('colours cells by class, leaving unknown see-through', () => {
    const px = landcoverPixels(lc({ data: Uint8Array.from([0, 6, 1, 1, 1, 1, 1, 1]) }), 150);
    expect(px[3]).toBe(0); expect([...px.slice(4, 8)]).toEqual([0x28, 0x64, 0xe6, 150]);
  });
});
