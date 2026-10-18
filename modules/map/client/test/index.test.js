import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createMap, loadMap } from '../index.js';

// 100 x 80 m area, 1 m cells. Ground rises 0.1 m per metre eastward from 10 m, with a sheer 30 m wall at x = 70.
// One 10 x 10 m building at x 20..30, y (north) 20..30.
const W = 100, H = 80;
const data = new Float32Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) data[r * W + c] = c + 0.5 >= 70 ? 40 : 10 + 0.1 * (c + 0.5);
const heightmap = { width: W, height: H, resolution: 1, data };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const bundle = () => ({
  meta: { id: 't', size_m: [W, H], heightmap: { min: 10, max: 40 }, attribution: ['A', 'B'] },
  heightmap, surface: null, imagery: { width: 4, height: 4 },
  buildings: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { base_z: 12, height: 8 }, geometry: { type: 'Polygon', coordinates: [sq(20, 20, 30, 30)] } }] },
});

describe('createMap land cover', () => {
  // 100 x 80 m, 0.5 m cells: the west half (x < 50) is grass, the east half road, except a river along y 70..80 (the north edge).
  const w = 200, h = 160, data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = r < 20 ? 6 : c < 100 ? 3 : 1;
  const map = createMap({ ...bundle(), landcover: { width: w, height: h, resolution: 0.5, data } });
  it('says what the ground is at a world point (X east, Z = -north)', () => {
    expect(map.surfaceAt(20, -40)).toEqual({ id: 3, name: 'grass' });
    expect(map.surfaceAt(80, -40)).toEqual({ id: 1, name: 'road' });
    expect(map.surfaceAt(20, -75)).toEqual({ id: 6, name: 'water' });                  // y = 75 m north
    expect(map.surfaceIdAt(80, -40)).toBe(1);
  });
  it('is unknown everywhere when the bundle has no layer, and the overlay does nothing', () => {
    const plain = createMap(bundle());
    expect(plain.hasLandcover).toBe(false); expect(plain.surfaceAt(20, -40)).toEqual({ id: 0, name: 'unknown' }); expect(plain.showLandcover(true)).toBe(false);
    expect(map.hasLandcover).toBe(true);
  });
});

describe('createMap', () => {
  const map = createMap(bundle());

  it('is a scene group with terrain, buildings and lights, plus metadata for the host', () => {
    expect(map.object).toBeInstanceOf(THREE.Group);
    const kinds = map.object.children.map((c) => c.name || c.type);
    expect(kinds).toEqual(expect.arrayContaining(['terrain', 'buildings', 'AmbientLight', 'DirectionalLight']));
    expect(map.attribution).toEqual(['A', 'B']); expect(map.size).toEqual([100, 80]);
  });
  it('groundY is in world units (X east, Z = -north, Y above the lowest ground)', () => {
    expect(map.groundY(10, -40)).toBeCloseTo(1.0 + 0.5 - 0.5, 1);     // 10 + 0.1*10 - 10 = 1
    expect(map.groundY(50, -40)).toBeCloseTo(5, 1);
  });
  it('isSolid and pushOutOfBuildings use world Z', () => {
    expect(map.isSolid(25, -25)).toBe(true); expect(map.isSolid(25, 25)).toBe(false);   // +Z would be south of the area
    const p = map.pushOutOfBuildings(19.8, -25);
    expect(p.x).toBeCloseTo(19.55, 2); expect(p.z).toBeCloseTo(-25, 3);                  // pushed back to the player radius
    expect(map.pushOutOfBuildings(5, -5)).toEqual({ x: 5, z: -5 });
  });
  it('clamp keeps points inside X 0..W, Z -D..0', () => {
    expect(map.clamp(-5, 5)).toEqual({ x: 0, z: 0 }); expect(map.clamp(500, -500)).toEqual({ x: 100, z: -80 }); expect(map.clamp(40, -40)).toEqual({ x: 40, z: -40 });
  });
  it('slope: a shallow rise slows you uphill only; the sheer wall blocks, sliding along it', () => {
    expect(map.slopeSpeedFactor(40, -40, 1, 0)).toBeGreaterThan(0.95); expect(map.slopeSpeedFactor(40, -40, 1, 0)).toBeLessThan(1);
    expect(map.slopeSpeedFactor(40, -40, -1, 0)).toBe(1);
    expect(map.limitSlope(40, -40, 41, -40)).toEqual({ x: 41, z: -40 });
    expect(map.limitSlope(69.2, -40, 70.4, -40)).toEqual({ x: 69.2, z: -40 });           // into the wall: held
    expect(map.limitSlope(69.2, -40, 70.4, -42)).toEqual({ x: 69.2, z: -42 });           // diagonal: slides along it
  });
  it('raycastGround finds the ground under a ray', () => {
    const hit = map.raycastGround(new THREE.Vector3(50, 100, -40), new THREE.Vector3(0, -1, 0));
    expect(hit.x).toBeCloseTo(50, 3); expect(hit.y).toBeCloseTo(map.groundY(50, -40), 2);
    expect(map.raycastGround(new THREE.Vector3(50, 100, -40), new THREE.Vector3(0, 1, 0))).toBeNull();
  });
});

describe('loadMap', () => {
  it('rejects with the URL when the bundle is missing', async () => {
    const fetchOld = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await expect(loadMap('/bundles/area_nope')).rejects.toThrow(/HTTP 404/);
    globalThis.fetch = fetchOld;
  });
});
