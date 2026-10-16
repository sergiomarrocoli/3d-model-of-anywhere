import * as THREE from 'three';

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
