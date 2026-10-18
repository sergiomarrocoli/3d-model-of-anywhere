// Land cover: what the ground is made of, for games to react to (grip, spray, slowing). Class ids match pipeline/landcover.py.
// The bundle's landcover.png is one 8-bit class id per cell (0.5 m), rows north to south like the other rasters.
import { decode } from 'fast-png';

export const SURFACE = Object.freeze({ UNKNOWN: 0, ROAD: 1, PAVED: 2, GRASS: 3, BARE: 4, TREE: 5, WATER: 6, BUILDING: 7 });
export const SURFACE_NAMES = Object.freeze(['unknown', 'road', 'paved', 'grass', 'bare', 'tree', 'water', 'building']);
const INFO = SURFACE_NAMES.map((name, id) => Object.freeze({ id, name }));   // shared, so asking per wheel per frame allocates nothing

/** Colours for the debug views and the tint overlay. */
export const SURFACE_COLOURS = Object.freeze(['#000000', '#5a5a64', '#bebec8', '#6ec850', '#c8a064', '#146420', '#2864e6', '#dc3c3c']);

export function decodeLandcover(pngBytes, lc) {
  const png = decode(pngBytes);
  if (png.depth !== 8 || png.channels !== 1) throw new Error(`landcover must be 8-bit greyscale, got ${png.depth}-bit x${png.channels}`);
  if (png.width !== lc.width || png.height !== lc.height) throw new Error(`landcover is ${png.width}x${png.height}, meta says ${lc.width}x${lc.height}`);
  return { width: png.width, height: png.height, resolution: lc.resolution_m, data: png.data };
}

/** The class id at bundle-local metres (x east, y north). Outside the box it is the nearest edge cell; with no layer, UNKNOWN. */
export function surfaceIdAt(landcover, x, y) {
  if (!landcover) return SURFACE.UNKNOWN;
  const { width, height, resolution, data } = landcover;
  const col = Math.min(width - 1, Math.max(0, Math.floor(x / resolution)));
  const row = Math.min(height - 1, Math.max(0, height - 1 - Math.floor(y / resolution)));
  return data[row * width + col];
}

/** { id, name } for a class id (the same frozen object each time); anything unexpected is UNKNOWN. */
export const surfaceInfo = (id) => INFO[id] ?? INFO[0];

/** An RGBA pixel buffer of the layer, for drawing it (debug page, overlay texture). `alpha` 0..255. */
export function landcoverPixels(landcover, alpha = 255) {
  const rgb = SURFACE_COLOURS.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
  const out = new Uint8ClampedArray(landcover.data.length * 4);
  for (let i = 0; i < landcover.data.length; i++) {
    const c = rgb[landcover.data[i]] ?? rgb[0];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = landcover.data[i] === SURFACE.UNKNOWN ? 0 : alpha;
  }
  return out;
}
