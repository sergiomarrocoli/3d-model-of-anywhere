// Loads a tile bundle written by pipeline/bundle.py (format documented there).
// Local coordinates: metres east (x) and north (y) of the box's south-west corner.
// Raster rows run north to south; heightmap pixel (col, row) is the elevation at x = col + 0.5, y = height - row - 0.5.
import { decode } from 'fast-png';
import { decodeLandcover } from './landcover.js';

export function decodeHeightmap(pngBytes, hm) {
  const png = decode(pngBytes);
  if (png.depth !== 16 || png.channels !== 1) throw new Error(`heightmap must be 16-bit greyscale, got ${png.depth}-bit x${png.channels}`);
  if (png.width !== hm.width || png.height !== hm.height) throw new Error(`heightmap is ${png.width}x${png.height}, meta says ${hm.width}x${hm.height}`);
  const z = new Float32Array(png.data.length);
  const span = hm.max - hm.min;
  for (let i = 0; i < z.length; i++) z[i] = hm.min + (png.data[i] / 65535) * span;
  return { width: png.width, height: png.height, resolution: hm.resolution_m, data: z };
}

async function fetchOk(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const browserLoadImage = async (blob) => createImageBitmap(blob);

export async function loadBundle(baseUrl, { fetchImpl = fetch, loadImage = browserLoadImage } = {}) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const meta = await (await fetchOk(`${base}meta.json`, fetchImpl)).json();
  if (meta.version !== 1) throw new Error(`unsupported bundle version ${meta.version}`);
  const [pngBuf, imgBlob, buildings, surfBuf, landBuf] = await Promise.all([
    fetchOk(base + meta.heightmap.file, fetchImpl).then((r) => r.arrayBuffer()),
    fetchOk(base + meta.imagery.file, fetchImpl).then((r) => r.blob()),
    fetchOk(base + meta.buildings.file, fetchImpl).then((r) => r.json()),
    meta.surfacemap ? fetchOk(base + meta.surfacemap.file, fetchImpl).then((r) => r.arrayBuffer()) : null, // optional LiDAR DSM
    meta.landcover ? fetchOk(base + meta.landcover.file, fetchImpl).then((r) => r.arrayBuffer()) : null,   // optional land cover
  ]);
  if (buildings.type !== 'FeatureCollection' || buildings.features.length !== meta.buildings.count) {
    throw new Error(`buildings file does not match meta (${buildings.features?.length} vs ${meta.buildings.count})`);
  }
  return {
    meta,
    heightmap: decodeHeightmap(new Uint8Array(pngBuf), meta.heightmap),
    surface: surfBuf ? decodeHeightmap(new Uint8Array(surfBuf), meta.surfacemap) : null,
    landcover: landBuf ? decodeLandcover(new Uint8Array(landBuf), meta.landcover) : null,
    imagery: await loadImage(imgBlob),
    buildings,
  };
}
