import * as THREE from 'three';

export const MAX_SPEED = 6;      // m/s, a brisk jog
export const ACCEL = 25;         // m/s^2
export const ARRIVE_RADIUS = 0.15;

/**
 * Where a ray meets the terrain heightfield. `heightAt(x, z)` gives world-space ground Y at world (x, z).
 * Marches along the ray in `step` metre increments then bisects, so it costs ~hundreds of samples, not a
 * mesh raycast over millions of triangles. Returns a Vector3 or null (ray misses / leaves the range).
 */
export function rayHeightfield(origin, dir, heightAt, { maxDist = 2000, step = 1 } = {}) {
  const p = new THREE.Vector3();
  const above = (t) => { p.copy(dir).multiplyScalar(t).add(origin); return p.y - heightAt(p.x, p.z); };
  let t0 = 0, h0 = above(0);
  if (h0 < 0) return null; // camera below ground
  for (let t = step; t <= maxDist; t += step) {
    const h = above(t);
    if (h <= 0) {
      let lo = t0, hi = t;
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; (above(m) > 0 ? (lo = m) : (hi = m)); }
      above((lo + hi) / 2);
      return p.clone();
    }
    t0 = t; h0 = h;
  }
  return null;
}

/**
 * One step of click-to-move with velocity smoothing. state = { x, z, vx, vz, heading } in world metres,
 * target = {x, z} | null. Accelerates toward the target, slows so it stops on it (v^2 = 2 a d), and
 * turns to face the direction of travel. Mutates and returns state; `state.moving` says whether it is walking.
 */
export function stepPlayer(state, target, dt, { maxSpeed = MAX_SPEED, accel = ACCEL } = {}) {
  let wantX = 0, wantZ = 0;
  if (target) {
    const dx = target.x - state.x, dz = target.z - state.z, d = Math.hypot(dx, dz);
    if (d > ARRIVE_RADIUS) {
      const speed = Math.min(maxSpeed, Math.sqrt(2 * accel * d)); // brake in time to arrive at rest
      wantX = (dx / d) * speed; wantZ = (dz / d) * speed;
    }
  }
  const ax = wantX - state.vx, az = wantZ - state.vz, dv = Math.hypot(ax, az), maxDv = accel * dt;
  if (dv > maxDv) { state.vx += (ax / dv) * maxDv; state.vz += (az / dv) * maxDv; }
  else { state.vx = wantX; state.vz = wantZ; }
  let nx = state.x + state.vx * dt, nz = state.z + state.vz * dt;
  if (target) { // never overshoot the target within a frame
    const dx = target.x - state.x, dz = target.z - state.z;
    if ((nx - state.x) ** 2 + (nz - state.z) ** 2 >= dx * dx + dz * dz) { nx = target.x; nz = target.z; state.vx = state.vz = 0; }
  }
  state.x = nx; state.z = nz;
  const speed = Math.hypot(state.vx, state.vz);
  state.moving = speed > 0.05;
  if (state.moving) {
    const want = Math.atan2(state.vx, state.vz);
    let diff = Math.atan2(Math.sin(want - state.heading), Math.cos(want - state.heading));
    state.heading += diff * Math.min(1, dt * 12);
  }
  return state;
}
