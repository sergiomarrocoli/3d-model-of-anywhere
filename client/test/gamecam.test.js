import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { cameraOffset, frustum, createGameCamera, VIEW_WIDTH_M, MAX_VIEW_M, MIN_VIEW_M, MIN_TILT_DEG, MAX_TILT_DEG } from '../src/gamecam.js';

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
    const { camera, follow } = createGameCamera({ aspect: 1.5, viewWidth: 50 });
    const t = new THREE.Vector3(100, 10, -100); follow(t);
    expect(new THREE.Vector3(125, 10, -100).project(cam(camera)).x).toBeCloseTo(1, 6);
  });
  it('north is up the screen', () => {
    const { camera, follow } = createGameCamera();
    const t = new THREE.Vector3(0, 0, 0); follow(t);
    expect(new THREE.Vector3(0, 0, -10).project(cam(camera)).y).toBeGreaterThan(0);
  });

  it('defaults to 150 m across (3x zoomed out from 50 m)', () => {
    expect(VIEW_WIDTH_M).toBe(150);
    const { camera } = createGameCamera({ aspect: 1 });
    expect(camera.right - camera.left).toBe(150);
  });
  it('zoom is multiplicative and clamped, and keeps the target centred', () => {
    const g = createGameCamera({ aspect: 2 });
    const t = new THREE.Vector3(40, 3, -60); g.follow(t);
    g.zoomBy(2); expect(g.camera.right - g.camera.left).toBeCloseTo(300);
    g.zoomBy(1e9); expect(g.state.viewWidth).toBe(MAX_VIEW_M);
    g.zoomBy(1e-12); expect(g.state.viewWidth).toBe(MIN_VIEW_M);
    const ndc = t.clone().project(cam(g.camera));
    expect(Math.abs(ndc.x)).toBeLessThan(1e-6); expect(Math.abs(ndc.y)).toBeLessThan(1e-6);
  });
  it('tilt changes the view angle, is clamped, keeps the target centred and north up', () => {
    const g = createGameCamera({ aspect: 1.5 });
    const t = new THREE.Vector3(10, 2, -10); g.follow(t);
    g.tiltBy(-1000); expect(g.state.tiltDeg).toBe(MIN_TILT_DEG);
    g.tiltBy(1000); expect(g.state.tiltDeg).toBe(MAX_TILT_DEG); // 89
    g.tiltBy(-29); expect(g.state.tiltDeg).toBe(60);
    cam(g.camera);
    const ndc = t.clone().project(g.camera);
    expect(Math.abs(ndc.x)).toBeLessThan(1e-6); expect(Math.abs(ndc.y)).toBeLessThan(1e-6);
    expect(new THREE.Vector3(10, 2, -20).project(g.camera).y).toBeGreaterThan(0);
  });

  it('yaw orbits the camera around the target: keeps it centred, changes the compass direction, wraps', () => {
    const g = createGameCamera({ aspect: 1.5, viewWidth: 50 });
    const t = new THREE.Vector3(10, 2, -10); g.follow(t);
    g.yawBy(90);                       // camera now east of the target, looking west
    cam(g.camera);
    expect(g.camera.position.x).toBeGreaterThan(t.x + 1);
    expect(Math.abs(g.camera.position.z - t.z)).toBeLessThan(1e-6);
    const ndc = t.clone().project(g.camera);
    expect(Math.abs(ndc.x)).toBeLessThan(1e-6); expect(Math.abs(ndc.y)).toBeLessThan(1e-6);
    expect(new THREE.Vector3(-10, 2, -10).project(g.camera).y).toBeGreaterThan(0);   // west is now up the screen
    g.yawBy(-450); expect(g.state.yawDeg).toBeCloseTo(0);                              // 90 - 450 = -360 -> 0
    g.yawBy(-10); expect(g.state.yawDeg).toBeCloseTo(350);
  });
  it('rotation survives zoom, tilt and following', () => {
    const g = createGameCamera();
    g.yawBy(45); const q = g.camera.quaternion.clone();
    g.zoomBy(2); g.follow(new THREE.Vector3(500, 0, -500));
    expect(g.camera.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });
});
