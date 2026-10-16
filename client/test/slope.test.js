import { describe, it, expect } from 'vitest';
import { slopeAt, canStep, resolveSlope, MAX_SLOPE } from '../src/slope.js';

// 100x100 heightmap, 1 m cells; height = f(x, y) at cell centres, rows north to south.
const make = (f) => {
  const n = 100, data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = f(c + 0.5, n - r - 0.5);
  return { width: n, height: n, resolution: 1, data };
};
const flat = make(() => 10);
const ramp = (k) => make((x) => k * x);                // rises eastward with gradient k
const cliff = make((x) => (x < 50 ? 0 : 20));          // 20 m wall at x = 50

describe('slope', () => {
  it('flat ground has zero slope; a ramp has its gradient', () => {
    expect(slopeAt(flat, 50, 50)).toBeCloseTo(0);
    expect(slopeAt(ramp(0.3), 50, 50)).toBeCloseTo(0.3);
  });
  it('allows gentle slopes and blocks steep ones uphill', () => {
    expect(canStep(ramp(0.3), 40, 50, 41, 50)).toBe(true);
    expect(canStep(ramp(2), 40, 50, 41, 50)).toBe(false);
  });
  it('always allows going downhill, even on a steep slope (no trapping)', () => {
    expect(canStep(ramp(2), 41, 50, 40, 50)).toBe(true);
  });
  it('blocks walking into a cliff but not along its foot', () => {
    expect(resolveSlope(cliff, 48.5, 50, 49.6, 50)).toEqual({ x: 48.5, y: 50 });
    const slid = resolveSlope(cliff, 48.5, 50, 49.6, 52);
    expect(slid.x).toBe(48.5); expect(slid.y).toBe(52);
  });
  it('threshold is 40 degrees', () => { expect(MAX_SLOPE).toBeCloseTo(0.839, 3); });
});
