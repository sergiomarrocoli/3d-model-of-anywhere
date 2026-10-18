import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createMap } from '../index.js';
import { buildBuildingGeometry } from '../buildings.js';
import { COLLAPSE_S, HEALTH_BASE, HEALTH_PER_ROOT_VOLUME, RUBBLE_SLOWDOWN, SMOKE_FROM, buildingHealth, footprintArea } from '../destruction.js';

// 120 x 80 m flat area. Building 0: a 10 x 10 x 8 m block at x 20..30, y 20..30. Building 1: a 3 x 3 x 3 m shed at x 50..53. Building 2: a 12 x 10 x 9 m one at x 80..92.
const W = 120, H = 80;
const heightmap = { width: W, height: H, resolution: 1, data: new Float32Array(W * H).fill(10) };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feature = (ring, height, base_z = 10) => ({ type: 'Feature', properties: { base_z, height }, geometry: { type: 'Polygon', coordinates: [ring] } });
const bundle = () => ({
  meta: { id: 't', size_m: [W, H], heightmap: { min: 10, max: 10 }, attribution: [] }, heightmap, surface: null, imagery: { width: 4, height: 4 },
  buildings: { type: 'FeatureCollection', features: [feature(sq(20, 20, 30, 30), 8), feature(sq(50, 20, 53, 23), 3), feature(sq(80, 20, 92, 30), 9)] },
});
const make = () => { const map = createMap(bundle()), d = map.destruction, group = map.object.children.find((c) => c.name === 'buildings'); return { map, d, group, ...group.userData }; };
const visibleSprites = (d) => d.group.children.filter((c) => c.isSprite && c.visible);
const run = (d, seconds) => { for (let t = 0; t < seconds; t += 1 / 60) d.update(1 / 60); };
const wallsOf = (m, id) => { const r = m.ranges.find((x) => x.id === id); return Array.from(m.wallMesh.geometry.index.array.slice(r.wallI[0], r.wallI[1])); };

describe('how tough a building is', () => {
  it('comes from its size: a shed is weak, a house tougher, a block much tougher', () => {
    expect(buildingHealth(12, 2.5)).toBeCloseTo(HEALTH_BASE + HEALTH_PER_ROOT_VOLUME * Math.sqrt(30));
    expect(buildingHealth(12, 2.5)).toBeLessThan(60); expect(buildingHealth(50, 7)).toBeGreaterThan(100); expect(buildingHealth(50, 7)).toBeLessThan(140); expect(buildingHealth(600, 15)).toBeGreaterThan(380);
    expect(buildingHealth(0, 0)).toBe(HEALTH_BASE);
  });
  it('the footprint is the outer ring less the courtyards', () => {
    expect(footprintArea([sq(0, 0, 10, 10)])).toBe(100); expect(footprintArea([sq(0, 0, 10, 10), sq(2, 2, 4, 4)])).toBe(96);
  });
  it('each building in a map has the health its size says', () => {
    const { d } = make(); expect(d.healthOf(0)).toBeCloseTo(buildingHealth(100, 8)); expect(d.healthOf(1)).toBeCloseTo(buildingHealth(9, 3)); expect(d.healthOf(7)).toBeNull();
    expect(d.stateOf(0)).toBe('standing');
  });
});

describe('the mesh keeps track of each building', () => {
  it('buildBuildingGeometry says where each building\'s vertices and triangles are', () => {
    const { ranges, walls, roofs } = buildBuildingGeometry(bundle().meta, bundle().buildings);
    expect(ranges.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(ranges[0].wallV[0]).toBe(0); expect(ranges[0].wallV[1]).toBe(16); expect(ranges[1].wallV[0]).toBe(16);                        // a square has four walls of four vertices
    expect(ranges[2].wallI[1]).toBe(walls.index.count); expect(ranges[2].roofI[1]).toBe(roofs.index.count); expect(ranges[0].height).toBe(8);
    expect(walls.attributes.wallDamage.count).toBe(walls.attributes.position.count); expect(roofs.attributes.color.array.every((v) => v === 1)).toBe(true);
  });
});

describe('damage', () => {
  it('lowers health, darkens that building\'s walls and roof and no other', () => {
    const { d, wallMesh, roofMesh, ranges } = make(), r0 = ranges[0], r1 = ranges[1], half = d.maxHealthOf(0) / 2;
    expect(d.damage(0, half)).toEqual({ id: 0, hp: expect.closeTo(half), collapsed: false });
    const dmg = wallMesh.geometry.attributes.wallDamage.array, col = roofMesh.geometry.attributes.color.array;
    expect(dmg[r0.wallV[0]]).toBeCloseTo(0.5); expect(dmg[r0.wallV[1] - 1]).toBeCloseTo(0.5); expect(dmg[r1.wallV[0]]).toBe(0);              // the next building is untouched
    expect(col[r0.roofV[0] * 3]).toBeLessThan(0.8); expect(col[r1.roofV[0] * 3]).toBe(1);
  });
  it('tells listeners, and ignores nonsense', () => {
    const { d } = make(), seen = []; const off = d.on((e) => seen.push(e));
    d.damage(1, 10); expect(seen).toEqual([expect.objectContaining({ type: 'damage', id: 1, amount: 10 })]); expect(seen[0].hp).toBeCloseTo(d.maxHealthOf(1) - 10);
    expect(d.damage(1, 0)).toBeNull(); expect(d.damage(1, -5)).toBeNull(); expect(d.damage(99, 5)).toBeNull(); expect(seen.length).toBe(1);
    off(); d.damage(1, 1); expect(seen.length).toBe(1);
  });
  it('damageAt hits the building at a point, or the nearest within reach, in world coordinates (Z = -north)', () => {
    const { d } = make();
    expect(d.buildingAt(25, -25)).toBe(0); expect(d.buildingAt(35, -25)).toBeNull(); expect(d.buildingAt(33, -25, 4)).toBe(0); expect(d.buildingAt(25, 25)).toBeNull();
    expect(d.damageAt(25, -25, 5).id).toBe(0); expect(d.damageAt(35, -25, 5)).toBeNull(); expect(d.damageAt(33, -25, 5, 4).id).toBe(0);
  });
  it('a blast hurts every building in its radius, most the closest, nothing past the edge', () => {
    const { d } = make(), before = [d.healthOf(0), d.healthOf(1), d.healthOf(2)];
    const out = d.blast(40, -25, 14, 40);                                       // 10 m from the block's wall, 10 m from the shed, 40 from the third
    expect(out.map((r) => r.id).sort()).toEqual([0, 1]);
    expect(before[0] - d.healthOf(0)).toBeCloseTo(40 * (1 - 10 / 14)); expect(before[2]).toBe(d.healthOf(2));
    const near = createMap(bundle()).destruction; near.blast(32, -25, 14, 40); expect(near.healthOf(0)).toBeLessThan(d.healthOf(0));     // closer, more
    expect(make().d.blast(40, -25, 4, 40)).toEqual([]);
  });
  it('a badly hurt building smokes from its roof; a sound one does not', () => {
    const { d } = make(); run(d, 1); expect(visibleSprites(d).length).toBe(0);
    d.damage(0, d.maxHealthOf(0) * (SMOKE_FROM + 0.1)); run(d, 1); expect(visibleSprites(d).length).toBeGreaterThan(3);
  });
});

describe('collapse', () => {
  it('at no health the building comes out of the collision grid at once, and out of the merged mesh into a piece that falls', () => {
    const { d, map, group, wallMesh } = make(), seen = [], before = wallsOf({ ranges: make().ranges, wallMesh }, 0); d.on((e) => seen.push(e.type));
    expect(map.isSolid(25, -25)).toBe(true); expect(before.some((i) => i !== 0)).toBe(true);
    const r = d.damage(0, 1e6);
    expect(r).toEqual({ id: 0, hp: 0, collapsed: true }); expect(d.stateOf(0)).toBe('collapsing'); expect(d.isCollapsed(0)).toBe(true);
    expect(map.isSolid(25, -25)).toBe(false); expect(map.pushOutOfBuildings(25, -25, 1)).toEqual({ x: 25, z: -25 });          // walk (or drive) straight through
    expect(wallsOf({ ranges: make().ranges, wallMesh }, 0).every((i) => i === 0)).toBe(true);                                // its triangles are gone from the walls...
    expect(d.group.children.some((c) => c.isGroup)).toBe(true);                                                              // ...and are a falling piece
    expect(map.isSolid(51, -21)).toBe(true); expect(seen).toEqual(['damage', 'collapse']);
    expect(group.children.length).toBeGreaterThan(2);
  });
  it('the piece shakes, then sinks to a fraction of its height, in dust and flying debris, and is then rubble', () => {
    const { d, map } = make(), types = []; d.on((e) => types.push(e.type)); d.damage(0, 1e6);
    const piece = () => d.group.children.find((c) => c.isGroup);
    run(d, 0.2); expect(piece().scale.y).toBe(1); expect(visibleSprites(d).length).toBeGreaterThan(0);                           // shuddering, first dust
    run(d, 0.8); expect(piece().scale.y).toBeLessThan(0.9); expect(d.group.children.filter((c) => c.isMesh && !c.isInstancedMesh).length).toBeGreaterThan(5);   // sinking, with debris
    run(d, COLLAPSE_S); expect(d.stateOf(0)).toBe('rubble'); expect(types).toEqual(['damage', 'collapse', 'rubble']);
    expect(d.group.children.some((c) => c.isGroup)).toBe(false); expect(d.group.children.find((c) => c.isInstancedMesh && c.name === 'rubble').count).toBeGreaterThanOrEqual(8);
    expect(map.rubbleAt(25, -25)).toBe(true); expect(map.rubbleAt(35, -25)).toBe(false);
  });
  it('the rubble is a low pile inside the footprint, sitting on the ground', () => {
    const { d } = make(); d.damage(0, 1e6); run(d, COLLAPSE_S + 0.2);
    const pile = d.group.children.find((c) => c.name === 'rubble'), m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
    let tallest = 0;
    for (let i = 0; i < pile.count; i++) {
      pile.getMatrixAt(i, m); m.decompose(p, q, s);
      expect(p.x).toBeGreaterThanOrEqual(20 - 1); expect(p.x).toBeLessThanOrEqual(30 + 1); expect(-p.z).toBeGreaterThanOrEqual(20 - 1); expect(-p.z).toBeLessThanOrEqual(30 + 1);
      expect(p.y - s.y / 2).toBeCloseTo(-0.1, 0);                                                    // sits on the ground (flat, at height 0)
      tallest = Math.max(tallest, s.y);
    }
    expect(tallest).toBeLessThan(3.5); expect(tallest).toBeGreaterThan(0.8);
  });
  it('an ash patch in the shape of the footprint lies under the rubble, covering the roof in the aerial photo', () => {
    const { d } = make(); d.damage(0, 1e6); run(d, COLLAPSE_S + 0.2);
    const ash = d.group.children.find((c) => c.name === 'ash'); ash.geometry.computeBoundingBox(); const box = ash.geometry.boundingBox;
    expect([box.min.x, box.max.x]).toEqual([20, 30]); expect([-box.max.z, -box.min.z]).toEqual([20, 30]); expect(ash.position.y).toBeGreaterThan(0);
  });
  it('rubble slows a car or a person, and nothing else does', () => {
    const { d, map } = make(); const flat = map.slopeSpeedFactor(40, -25, 1, 0); expect(flat).toBe(1);
    d.damage(0, 1e6); run(d, COLLAPSE_S + 0.2);
    expect(map.slopeSpeedFactor(24, -25, 1, 0)).toBeCloseTo(RUBBLE_SLOWDOWN); expect(map.slopeSpeedFactor(40, -25, 1, 0)).toBe(1);
  });
  it('a collapsed building cannot be damaged again, and the others still can', () => {
    const { d } = make(); d.damage(0, 1e6); expect(d.damage(0, 5)).toBeNull(); expect(d.damageAt(25, -25, 5)).toBeNull(); expect(d.collapse(0)).toBe(false); expect(d.damage(1, 5)).not.toBeNull();
    expect(d.blast(25, -25, 10, 50).map((r) => r.id)).toEqual([]);                                  // the rubble is not a building: a blast over it hurts nothing
  });
  it('a bigger building throws more dust and debris, and a blast that is big enough takes down a shed but not a block', () => {
    const { d } = make(); const res = d.blast(51.5, -21.5, 10, 120); expect(res.find((r) => r.id === 1).collapsed).toBe(true); expect(d.stateOf(0)).toBe('standing');
    const a = make(), b = make(); a.d.damage(1, 1e6); b.d.damage(2, 1e6); run(a.d, 0.5); run(b.d, 0.5);
    const debris = (x) => x.d.group.children.filter((c) => c.isMesh && !c.isInstancedMesh).length; expect(debris(b)).toBeGreaterThan(debris(a));
  });
});

describe('restore', () => {
  it('puts the buildings, the collision, the meshes and the damage all back, and clears the rubble and dust', () => {
    const { d, map, wallMesh, roofMesh, ranges } = make(), walls0 = Array.from(wallMesh.geometry.index.array), roofs0 = Array.from(roofMesh.geometry.index.array), types = []; d.on((e) => types.push(e.type));
    d.damage(0, 1e6); d.damage(1, 20); d.damage(2, d.maxHealthOf(2) * 0.7); run(d, 0.6);
    d.damage(2, 1e6); run(d, COLLAPSE_S + 0.2);
    d.restore();
    expect(Array.from(wallMesh.geometry.index.array)).toEqual(walls0); expect(Array.from(roofMesh.geometry.index.array)).toEqual(roofs0);
    expect(map.isSolid(25, -25)).toBe(true); expect(map.isSolid(86, -25)).toBe(true); expect(map.rubbleAt(25, -25)).toBe(false); expect(d.stateOf(0)).toBe('standing'); expect(d.healthOf(1)).toBe(d.maxHealthOf(1));
    expect(wallMesh.geometry.attributes.wallDamage.array.every((v) => v === 0)).toBe(true); expect(roofMesh.geometry.attributes.color.array[ranges[0].roofV[0] * 3]).toBe(1);
    expect(d.group.children.filter((c) => c.isGroup || c.isMesh || c.isInstancedMesh).length).toBe(0); expect(visibleSprites(d).length).toBe(0);
    expect(types.filter((t) => t === 'restore').length).toBe(3);
    d.update(1); expect(visibleSprites(d).length).toBe(0);                                          // nothing smoulders on
    expect(d.damage(0, 5)).not.toBeNull();                                                          // and they can be knocked down all over again
  });
});
