import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { decodeHeightmap, loadBundle } from '../bundle.js';

const hm = { width: 3, height: 2, resolution_m: 1, min: 10, max: 20 };
const png16 = (data, width = 3, height = 2) => encode({ width, height, data: Uint16Array.from(data), depth: 16, channels: 1 });

describe('decodeHeightmap', () => {
  it('maps 16-bit values back to metres, row 0 first', () => {
    const out = decodeHeightmap(png16([0, 65535, 32768, 0, 0, 65535]), hm);
    expect(out.data[0]).toBeCloseTo(10); expect(out.data[1]).toBeCloseTo(20); expect(out.data[2]).toBeCloseTo(15, 3);
    expect(out.width).toBe(3); expect(out.height).toBe(2);
  });
  it('rejects wrong size and 8-bit input', () => {
    expect(() => decodeHeightmap(png16([0, 0, 0, 0], 2, 2), hm)).toThrow(/meta says/);
    const png8 = encode({ width: 3, height: 2, data: new Uint8Array(6), depth: 8, channels: 1 });
    expect(() => decodeHeightmap(png8, hm)).toThrow(/16-bit/);
  });
});

describe('loadBundle', () => {
  const meta = { version: 1, id: 't', heightmap: { file: 'h.png', ...hm }, imagery: { file: 'i.jpg' }, buildings: { file: 'b.geojson', count: 1 } };
  const files = (over = {}) => ({
    'meta.json': JSON.stringify(meta), 'h.png': png16([0, 0, 0, 0, 0, 0]), 'i.jpg': 'img',
    'b.geojson': JSON.stringify({ type: 'FeatureCollection', features: [{}] }), ...over,
  });
  const fakeFetch = (f) => async (url) => {
    const key = url.split('/').pop();
    if (!(key in f)) return { ok: false, status: 404 };
    const body = f[key];
    return { ok: true, status: 200, json: async () => JSON.parse(body), arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new TextEncoder().encode(body).buffer), blob: async () => body };
  };
  const opts = (f) => ({ fetchImpl: fakeFetch(f), loadImage: async (b) => ({ width: 1, height: 1, blob: b }) });

  it('loads all four parts', async () => {
    const b = await loadBundle('/bundles/area_t', opts(files()));
    expect(b.meta.id).toBe('t'); expect(b.heightmap.data).toHaveLength(6); expect(b.imagery.width).toBe(1); expect(b.buildings.features).toHaveLength(1);
  });
  it('reports a missing file with its URL', async () => {
    const f = files(); delete f['i.jpg'];
    await expect(loadBundle('/bundles/area_t', opts(f))).rejects.toThrow(/i\.jpg: HTTP 404/);
  });
  it('rejects a building count mismatch and unknown versions', async () => {
    await expect(loadBundle('/x', opts(files({ 'b.geojson': JSON.stringify({ type: 'FeatureCollection', features: [] }) })))).rejects.toThrow(/does not match/);
    await expect(loadBundle('/x', opts(files({ 'meta.json': JSON.stringify({ ...meta, version: 2 }) })))).rejects.toThrow(/version/);
  });
  it('has no surface unless the meta declares a surfacemap, and decodes it when it does', async () => {
    expect((await loadBundle('/x', opts(files()))).surface).toBeNull();
    const withSurface = files({ 'meta.json': JSON.stringify({ ...meta, surfacemap: { file: 's.png', ...hm, min: 0, max: 65535 } }), 's.png': png16([0, 1, 2, 3, 4, 5]) });
    const b = await loadBundle('/x', opts(withSurface));
    expect(Array.from(b.surface.data)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
