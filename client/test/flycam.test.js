import { describe, it, expect } from 'vitest';
import { flyDelta } from '../src/flycam.js';

describe('flyDelta', () => {
  it('W moves north (-Z) when facing north', () => {
    const d = flyDelta(new Set(['KeyW']), 0, 1, 10);
    expect(d.z).toBeCloseTo(-10); expect(d.x).toBeCloseTo(0);
  });
  it('D moves east (+X) when facing north', () => {
    expect(flyDelta(new Set(['KeyD']), 0, 1, 10).x).toBeCloseTo(10);
  });
  it('turning left 90 degrees makes W go west', () => {
    expect(flyDelta(new Set(['KeyW']), Math.PI / 2, 1, 10).x).toBeCloseTo(-10);
  });
  it('E goes up, Shift is 4x, opposite keys cancel', () => {
    expect(flyDelta(new Set(['KeyE', 'ShiftLeft']), 0, 1, 10).y).toBeCloseTo(40);
    expect(flyDelta(new Set(['KeyW', 'KeyS']), 0, 1, 10).length()).toBeCloseTo(0);
  });
});
