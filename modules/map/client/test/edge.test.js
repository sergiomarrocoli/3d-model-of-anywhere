import { describe, it, expect } from 'vitest';
import { clampToBox } from '../edge.js';

const W = 1000, H = 800;
describe('clampToBox', () => {
  it('lets the player walk right up to the edge (0 m)', () => {
    expect(clampToBox(0, 0, W, H)).toEqual({ x: 0, z: 0 });
    expect(clampToBox(W, -H, W, H)).toEqual({ x: W, z: -H });
  });
  it('stops positions beyond the edge at the edge', () => {
    expect(clampToBox(-10, 10, W, H)).toEqual({ x: 0, z: 0 });
    expect(clampToBox(2000, -2000, W, H)).toEqual({ x: W, z: -H });
  });
  it('leaves interior positions alone', () => {
    expect(clampToBox(300, -300, W, H)).toEqual({ x: 300, z: -300 });
  });
});
