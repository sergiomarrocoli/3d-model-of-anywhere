// Heightmap sampling. Pixel (col, row) holds the elevation at the CENTRE of that 1-cell square:
// local x = (col + 0.5) * res, y = (height - row - 0.5) * res (rows run north to south).

/** Bilinear elevation (metres) at local (x, y); clamps to the edge cells outside the pixel centres. */
export function sampleHeight(hm, x, y) {
  const { width, height, resolution: res, data } = hm;
  const fx = Math.min(Math.max(x / res - 0.5, 0), width - 1);
  const fy = Math.min(Math.max(height - y / res - 0.5, 0), height - 1); // fractional row
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  const c1 = Math.min(c0 + 1, width - 1), r1 = Math.min(r0 + 1, height - 1);
  const tx = fx - c0, ty = fy - r0;
  const top = data[r0 * width + c0] * (1 - tx) + data[r0 * width + c1] * tx;
  const bot = data[r1 * width + c0] * (1 - tx) + data[r1 * width + c1] * tx;
  return top * (1 - ty) + bot * ty;
}
