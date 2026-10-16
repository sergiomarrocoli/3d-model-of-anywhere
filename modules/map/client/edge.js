/** Keep a world-space position inside the box (world X east 0..W, world Z -H..0). Walkable right up to the edge. */
export function clampToBox(x, z, W, H) {
  return { x: Math.min(W, Math.max(0, x)), z: Math.min(0, Math.max(-H, z)) };
}
