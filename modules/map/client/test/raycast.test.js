import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { rayHeightfield } from '../raycast.js';

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
