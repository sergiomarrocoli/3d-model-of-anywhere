import { sampleHeight } from './heightmap.js';

// Only near-vertical ground (walls, sheer drops) blocks outright; anything shallower just slows you down.
// Getting onto roofs / into buildings is a separate mechanic, not walking up a wall.
export const MAX_SLOPE_DEG = 85;
export const MIN_SPEED_FACTOR = 0.15;
export const MAX_SLOPE = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180);

/** Ground gradient magnitude (rise over run) at local (x, y), by central differences over `d` metres. */
export function slopeAt(hm, x, y, d = 1) {
  const gx = (sampleHeight(hm, x + d / 2, y) - sampleHeight(hm, x - d / 2, y)) / d;
  const gy = (sampleHeight(hm, x, y + d / 2) - sampleHeight(hm, x, y - d / 2)) / d;
  return Math.hypot(gx, gy);
}

/** A step is allowed if it lands on walkable ground, or goes downhill (so you can never get trapped on a steep spot). */
export function canStep(hm, x0, y0, x1, y1, maxSlope = MAX_SLOPE) {
  return slopeAt(hm, x1, y1) <= maxSlope || sampleHeight(hm, x1, y1) <= sampleHeight(hm, x0, y0);
}

/**
 * Apply slope blocking to a proposed move (local x/y metres). If the full move is blocked, try each axis on its
 * own so the player slides along a cliff foot rather than stopping dead. Returns the allowed position.
 */
export function resolveSlope(hm, x0, y0, x1, y1, maxSlope = MAX_SLOPE) {
  if (canStep(hm, x0, y0, x1, y1, maxSlope)) return { x: x1, y: y1 };
  if (x1 !== x0 && canStep(hm, x0, y0, x1, y0, maxSlope)) return { x: x1, y: y0 };
  if (y1 !== y0 && canStep(hm, x0, y0, x0, y1, maxSlope)) return { x: x0, y: y1 };
  return { x: x0, y: y0 };
}

/**
 * Speed multiplier for moving from (x, y) along direction (dx, dy): uphill, 1 / (1 + s^2) = cos^2(angle) of the
 * slope along the direction of travel (45 degrees = half speed, 60 = a quarter), floored so you never stall short
 * of the block threshold. Level ground and downhill are full speed.
 */
export function speedFactor(hm, x, y, dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 1;
  const ux = dx / len, uy = dy / len, d = 1;
  const rise = (sampleHeight(hm, x + (ux * d) / 2, y + (uy * d) / 2) - sampleHeight(hm, x - (ux * d) / 2, y - (uy * d) / 2)) / d;
  if (rise <= 0) return 1;
  return Math.max(MIN_SPEED_FACTOR, 1 / (1 + rise * rise));
}
