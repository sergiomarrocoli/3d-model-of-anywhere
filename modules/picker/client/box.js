// The picker's box, in British National Grid metres: { minE, minN, maxE, maxN }. Pure functions, no map.

export const DEFAULT_SIZE_M = 1000;
export const MIN_SIZE_M = 200;
export const MAX_SIZE_M = 2000;
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function makeBox([e, n], size = DEFAULT_SIZE_M) {
  const h = clamp(size, MIN_SIZE_M, MAX_SIZE_M) / 2;
  return { minE: e - h, minN: n - h, maxE: e + h, maxN: n + h };
}

export const boxSize = (b) => ({ width: b.maxE - b.minE, height: b.maxN - b.minN });
export const boxCentre = (b) => [(b.minE + b.maxE) / 2, (b.minN + b.maxN) / 2];
export const boxBBox = (b) => [b.minE, b.minN, b.maxE, b.maxN];
export const boxCorners = (b) => [[b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN]];

export const moveBox = (b, dE, dN) => ({ minE: b.minE + dE, minN: b.minN + dN, maxE: b.maxE + dE, maxN: b.maxN + dN });

/** Where each handle sits on the box: [E, N]. */
export function handlePosition(b, handle) {
  const [cE, cN] = boxCentre(b);
  const E = handle.includes('w') ? b.minE : handle.includes('e') ? b.maxE : cE;
  const N = handle.includes('s') ? b.minN : handle.includes('n') ? b.maxN : cN;
  return [E, N];
}

/**
 * Drag a handle to the grid point (E, N). The edges that handle controls follow the pointer; the opposite edges stay put.
 * Each edge stops when the box would be smaller than `min` or larger than `max`, so the pointer can keep going while the box holds.
 */
export function resizeBox(b, handle, E, N, { min = MIN_SIZE_M, max = MAX_SIZE_M } = {}) {
  const r = { ...b };
  if (handle.includes('w')) r.minE = clamp(E, b.maxE - max, b.maxE - min);
  if (handle.includes('e')) r.maxE = clamp(E, b.minE + min, b.minE + max);
  if (handle.includes('s')) r.minN = clamp(N, b.maxN - max, b.maxN - min);
  if (handle.includes('n')) r.maxN = clamp(N, b.minN + min, b.minN + max);
  return r;
}

/** CSS cursor for a handle. */
export const handleCursor = (h) => ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' })[h];

/** The command that builds this box with the Python pipeline (until the build service exists). Rounded to whole metres. */
export function buildCommand(b, id = 'my-area') {
  const [a, c, d, e] = boxBBox(b).map(Math.round);
  return `python3 -m pipeline.build_area --bbox ${a} ${c} ${d} ${e} --id ${id}`;
}
