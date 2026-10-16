import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { rayHeightfield, stepPlayer, MAX_SPEED } from '../src/player.js';

const fresh = (x = 0, z = 0) => ({ x, z, vx: 0, vz: 0, heading: 0 });
const run = (s, target, seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) stepPlayer(s, target, dt); return s; };

describe('rayHeightfield', () => {
  it('hits flat ground where geometry says it should', () => {
    const o = new THREE.Vector3(10, 100, 0), d = new THREE.Vector3(0, -1, -1).normalize();
    const hit = rayHeightfield(o, d, () => 0);
    expect(hit.y).toBeCloseTo(0, 3); expect(hit.z).toBeCloseTo(-100, 2); expect(hit.x).toBeCloseTo(10, 3);
  });
  it('hits a sloped plane', () => {
    const hit = rayHeightfield(new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, -1, 0), (x) => x * 0.1 + 5);
    expect(hit.y).toBeCloseTo(5, 3);
  });
  it('misses when pointing up', () => {
    expect(rayHeightfield(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 1, 0), () => 0)).toBeNull();
  });
});

describe('stepPlayer', () => {
  it('walks to the target and stops on it', () => {
    const s = run(fresh(), { x: 20, z: -10 }, 8);
    expect(Math.hypot(s.x - 20, s.z + 10)).toBeLessThan(0.2);
    expect(Math.hypot(s.vx, s.vz)).toBeLessThan(0.1); expect(s.moving).toBe(false);
  });
  it('never exceeds max speed and accelerates smoothly (not instantly)', () => {
    const s = fresh(); stepPlayer(s, { x: 100, z: 0 }, 1 / 60);
    expect(Math.hypot(s.vx, s.vz)).toBeLessThan(MAX_SPEED / 2);
    let peak = 0; for (let i = 0; i < 600; i++) { stepPlayer(s, { x: 100, z: 0 }, 1 / 60); peak = Math.max(peak, Math.hypot(s.vx, s.vz)); }
    expect(peak).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
  });
  it('does not overshoot with a big frame step', () => {
    const s = fresh(); stepPlayer(s, { x: 1, z: 0 }, 5);
    expect(s.x).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('turns to face the direction of travel (east = +X)', () => {
    const s = run(fresh(), { x: 30, z: 0 }, 1);
    expect(s.heading).toBeCloseTo(Math.PI / 2, 1);
  });
  it('stays put with no target', () => {
    const s = run(fresh(5, 5), null, 1);
    expect(s.x).toBe(5); expect(s.z).toBe(5);
  });
});
