import { sampleHeight } from './heightmap.js';

export const MAX_SLOPE_DEG = 40;
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
