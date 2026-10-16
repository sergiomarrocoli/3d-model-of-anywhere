import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { cameraOffset, frustum, createGameCamera } from '../src/gamecam.js';

const cam = (c) => { c.updateMatrixWorld(true); return c; };

describe('game camera', () => {
  it('offset is due south and up at the tilt angle', () => {
    const o = cameraOffset(60, 100);
    expect(o.x).toBe(0);
    expect(o.y).toBeCloseTo(86.6, 1);
    expect(o.z).toBeCloseTo(50, 1);
  });
  it('frustum shows the requested width and respects aspect', () => {
    expect(frustum(2, 50)).toEqual({ halfW: 25, halfH: 12.5 });
  });
  it('follows the target without rotating, and keeps it centred on screen', () => {
    const { camera, follow } = createGameCamera({ aspect: 1.5 });
    follow(new THREE.Vector3(10, 5, -20));
    const q1 = camera.quaternion.clone();
    const target = new THREE.Vector3(300, 40, -250);
    follow(target);
    expect(camera.quaternion.angleTo(q1)).toBeLessThan(1e-6);
    const ndc = target.clone().project(cam(camera));
    expect(Math.abs(ndc.x)).toBeLessThan(1e-6); expect(Math.abs(ndc.y)).toBeLessThan(1e-6);
  });
  it('a point 25 m east of the target sits on the right screen edge (50 m wide view)', () => {
    const { camera, follow } = createGameCamera({ aspect: 1.5 });
    const t = new THREE.Vector3(100, 10, -100); follow(t);
    expect(new THREE.Vector3(125, 10, -100).project(cam(camera)).x).toBeCloseTo(1, 6);
  });
  it('north is up the screen', () => {
    const { camera, follow } = createGameCamera();
    const t = new THREE.Vector3(0, 0, 0); follow(t);
    expect(new THREE.Vector3(0, 0, -10).project(cam(camera)).y).toBeGreaterThan(0);
  });
});
