// Destroyable buildings. Every building has health from its size; a game damages it (`damage`, `damageAt`, `blast`) and it shows: the walls and roof go
// darker with cracks and holes, and a badly hurt one smokes. At no health it collapses: its triangles come out of the two merged building meshes into a piece that
// shakes and sinks in a cloud of dust and flying debris, leaving a pile of rubble. A collapsed building leaves the collision grid (cars and people go
// through it; the rubble slows them), and `restore` puts everything back, ready for another round. Coordinates are world ones (X east, Z = -north).
//   const d = createDestruction({ meta, buildings, grid, group, groundY });   // `group` is what buildBuildings made; createMap does all this
//   d.blast(x, z, 12, 300);  d.update(dt);  d.on((e) => ...)   // e: { type: 'damage' | 'collapse' | 'rubble' | 'restore', id, hp, x, z }
import * as THREE from 'three';
import { buildingEntry, buildingsNear, insideEntry, insideRubble, removeBuilding, restoreBuildings } from './collision.js';
import { toWorld } from './coords.js';

export const HEALTH_BASE = 30;           // a building's health: this plus HEALTH_PER_ROOT_VOLUME times the square root of its volume (a shed 50, a house 100, a block 400)
export const HEALTH_PER_ROOT_VOLUME = 4;
export const COLLAPSE_S = 1.8;           // how long a collapse takes, from the first shudder to the rubble
export const SHAKE_S = 0.35;             // ...of which this is shaking before it starts to go
export const RUBBLE_SLOWDOWN = 0.6;      // speed factor on the rubble of a collapsed building
export const SMOKE_FROM = 0.5;           // a building this damaged (0 sound to 1 about to fall) smokes
export const MAX_DUST = 300;
const DUST = [0xe9e0d0, 0xc8bca8, 0xa09584, 0x6e6558];                  // pixel dust, light to dark, no blending between steps
const RUBBLE_COLOURS = [0x6b6560, 0x857d74, 0x4f4a46, 0x8a5a40, 0x9a6a50, 0x5c5650, 0xa89f92];
const GRAVITY = 22;

const ringArea = (ring) => { let a = 0; for (let i = 0; i < ring.length; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]; a += x0 * y1 - x1 * y0; } return Math.abs(a) / 2; };
/** A building's footprint area in square metres: the outer ring less any courtyards. */
export const footprintArea = (rings) => rings.slice(1).reduce((a, r) => a - ringArea(r), ringArea(rings[0]));
/** How much damage a building of this footprint area (m2) and height (m) takes to bring down. */
export const buildingHealth = (area, height) => HEALTH_BASE + HEALTH_PER_ROOT_VOLUME * Math.sqrt(Math.max(0, area) * Math.max(0, height));

export function createDestruction({ meta, buildings, grid, group, groundY, random = Math.random }) {
  const { wallMesh, roofMesh, ranges } = group.userData;
  const wallGeo = wallMesh.geometry, roofGeo = roofMesh.geometry;
  const wallIndex = wallGeo.index, roofIndex = roofGeo.index, wallIndex0 = wallIndex.array.slice(), roofIndex0 = roofIndex.array.slice();
  const rand = (a, b) => a + (b - a) * random();
  const info = new Map(), listeners = new Set(), smoking = new Set();
  const live = new THREE.Group(); live.name = 'destruction'; group.add(live);        // collapsing pieces, rubble, debris, dust

  for (const range of ranges) {
    const entry = buildingEntry(grid, range.id), rings = entry.rings, area = footprintArea(rings), maxHp = buildingHealth(area, range.height);
    const cx = (entry.minX + entry.maxX) / 2, cy = (entry.minY + entry.maxY) / 2, [wx, wy, wz] = toWorld(meta, cx, cy, range.base);
    info.set(range.id, { id: range.id, range, entry, rings, area, maxHp, hp: maxHp, state: 'standing', level: 0, x: wx, z: wz, baseY: wy, height: range.height, radius: Math.hypot(entry.maxX - entry.minX, entry.maxY - entry.minY) / 2 });
  }
  const emit = (type, b, extra = {}) => { for (const fn of listeners) fn({ type, id: b.id, hp: Math.max(0, b.hp), x: b.x, z: b.z, ...extra }); };

  // --- what damage looks like on the merged meshes
  const showDamage = (b) => {
    const level = Math.max(0, Math.min(1, 1 - b.hp / b.maxHp)); b.level = level;
    const [w0, w1] = b.range.wallV, [r0, r1] = b.range.roofV, dmg = wallGeo.attributes.wallDamage, col = roofGeo.attributes.color, shade = 1 - 0.6 * level;
    for (let v = w0; v < w1; v++) dmg.array[v] = level;
    for (let v = r0; v < r1; v++) { col.array[v * 3] = shade; col.array[v * 3 + 1] = shade * 0.97; col.array[v * 3 + 2] = shade * 0.94; }
    dmg.needsUpdate = true; col.needsUpdate = true;
    if (level >= SMOKE_FROM && b.state === 'standing') smoking.add(b.id); else smoking.delete(b.id);
  };

  // --- dust: a pool of square pixels that rise, spread and fade through the palette
  const dustMats = DUST.map((c) => new THREE.SpriteMaterial({ color: c, depthWrite: false }));
  const dust = Array.from({ length: MAX_DUST }, () => { const s = new THREE.Sprite(dustMats[0]); s.visible = false; live.add(s); return { s, age: 9, life: 1, vx: 0, vy: 0, vz: 0, size: 1 }; });
  let nextDust = 0;
  const puff = (x, y, z, vx, vy, vz, life, size) => { const p = dust[nextDust]; nextDust = (nextDust + 1) % dust.length; Object.assign(p, { age: 0, life, vx, vy, vz, size }); p.s.visible = true; p.s.position.set(x, y, z); p.s.scale.setScalar(size); };

  // --- collapsing buildings, flying debris
  const falling = [], debris = [], rubble = new Map(), scorches = new Map();
  const slice = (geo, names, v0, v1) => {                                   // a new geometry of vertices v0..v1 of `geo`, with indices rebased
    const g = new THREE.BufferGeometry();
    for (const n of names) { const a = geo.attributes[n]; g.setAttribute(n, new THREE.BufferAttribute(a.array.slice(v0 * a.itemSize, v1 * a.itemSize), a.itemSize)); }
    return g;
  };
  const extract = (b) => {
    const wallNames = Object.keys(wallGeo.attributes), roofNames = Object.keys(roofGeo.attributes), piece = new THREE.Group(), meshes = [];
    for (const [geo, names, mesh, index, [v0, v1], [i0, i1]] of [[wallGeo, wallNames, wallMesh, wallIndex, b.range.wallV, b.range.wallI], [roofGeo, roofNames, roofMesh, roofIndex, b.range.roofV, b.range.roofI]]) {
      const g = slice(geo, names, v0, v1), idx = new Uint32Array(i1 - i0); for (let i = 0; i < idx.length; i++) idx[i] = index.array[i0 + i] - v0;
      g.setIndex(new THREE.BufferAttribute(idx, 1)); const m = new THREE.Mesh(g, mesh.material); piece.add(m); meshes.push(m);
      index.array.fill(0, i0, i1); index.needsUpdate = true;                  // the building is gone from the merged mesh: its triangles collapse to nothing
    }
    live.add(piece); return { piece, meshes };
  };
  const debrisGeo = new THREE.BoxGeometry(1, 1, 1), debrisMats = RUBBLE_COLOURS.map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const throwDebris = (b) => {
    const n = Math.min(40, Math.round(8 + b.area / 12));
    for (let i = 0; i < n; i++) {
      const a = random() * Math.PI * 2, out = rand(0.2, 1) * b.radius, m = new THREE.Mesh(debrisGeo, debrisMats[Math.floor(random() * debrisMats.length)]), sz = rand(0.4, 1.4);
      m.scale.set(sz * rand(0.7, 1.4), sz * rand(0.5, 1), sz * rand(0.7, 1.4)); m.position.set(b.x + Math.cos(a) * out, b.baseY + rand(0.3, 0.7) * b.height, b.z + Math.sin(a) * out); live.add(m);
      const sp = rand(3, 10); debris.push({ m, vx: Math.cos(a) * sp, vy: rand(1, 6), vz: Math.sin(a) * sp, sx: rand(-6, 6), sz: rand(-6, 6), age: 0, life: rand(2, 3) });
    }
  };
  const makeRubble = (b) => {                                               // a pile of boxes inside the footprint, tallest in the middle
    const e = b.entry, n = Math.max(8, Math.min(70, Math.round(b.area / 5))), mesh = new THREE.InstancedMesh(debrisGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), colour = new THREE.Color(); let placed = 0;
    for (let tries = 0; placed < n && tries < n * 30; tries++) {
      const lx = rand(e.minX, e.maxX), ly = rand(e.minY, e.maxY); if (!insideEntry(e, lx, ly)) continue;
      const [wx, , wz] = toWorld(meta, lx, ly, 0), d = Math.hypot(wx - b.x, wz - b.z) / Math.max(1, b.radius), h = rand(0.3, 0.9) + 1.5 * Math.max(0, 1 - d) ** 1.3, w = rand(0.6, 2.2);
      e3.set(rand(-0.25, 0.25), rand(0, Math.PI), rand(-0.25, 0.25)); q.setFromEuler(e3);
      m4.compose(new THREE.Vector3(wx, groundY(wx, wz) + h / 2 - 0.1, wz), q, new THREE.Vector3(w, h, w * rand(0.6, 1.4)));
      mesh.setMatrixAt(placed, m4); mesh.setColorAt(placed, colour.setHex(RUBBLE_COLOURS[Math.floor(random() * RUBBLE_COLOURS.length)])); placed++;
    }
    mesh.count = placed; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; mesh.name = 'rubble';
    live.add(mesh); rubble.set(b.id, mesh);
    // The aerial photo on the ground still shows the roof: lay an ash-dark patch in the shape of the footprint under the pile.
    const patch = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(b.rings[0].map(([x, y]) => new THREE.Vector2(x, y)))).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x2b2622, transparent: true, opacity: 0.78, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    patch.position.y = groundY(b.x, b.z) + 0.06; patch.name = 'ash'; live.add(patch); scorches.set(b.id, patch);
  };

  const api = {
    info, group: live,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    healthOf: (id) => info.get(id)?.hp ?? null,
    maxHealthOf: (id) => info.get(id)?.maxHp ?? null,
    stateOf: (id) => info.get(id)?.state ?? null,                           // 'standing' | 'collapsing' | 'rubble'
    isCollapsed: (id) => { const s = info.get(id)?.state; return s === 'collapsing' || s === 'rubble'; },
    /** The standing building at (x, z) or within `reach` metres of it, or null. */
    buildingAt(x, z, reach = 0) { const near = buildingsNear(grid, x, -z, reach).find((n) => info.has(n.id)); return near ? near.id : null; },
    /** The standing buildings within `radius` of (x, z): [{ id, d }], nearest first. */
    near: (x, z, radius) => buildingsNear(grid, x, -z, radius).filter((n) => info.has(n.id)),
    rubbleAt: (x, z) => insideRubble(grid, x, -z),
    /** Damage building `id`: returns { id, hp, collapsed }, or null if it is not standing. */
    damage(id, amount) {
      const b = info.get(id); if (!b || b.state !== 'standing' || !(amount > 0)) return null;
      b.hp -= amount; showDamage(b); emit('damage', b, { amount });
      if (b.hp <= 0) { api.collapse(id); return { id, hp: 0, collapsed: true }; }
      return { id, hp: b.hp, collapsed: false };
    },
    /** Damage the building at (x, z), or the nearest one within `reach` metres. */
    damageAt(x, z, amount, reach = 3) { const id = api.buildingAt(x, z, reach); return id === null ? null : api.damage(id, amount); },
    /** An explosion at (x, z): every building within `radius` of the blast takes `amount` at the wall, less with distance to nothing at the edge. Returns what happened to each. */
    blast(x, z, radius, amount) {
      const out = [];
      for (const { id, d } of api.near(x, z, radius)) { const r = api.damage(id, amount * (1 - d / radius)); if (r) out.push(r); }
      return out;
    },
    /** Bring a building down now. */
    collapse(id) {
      const b = info.get(id); if (!b || b.state !== 'standing') return false;
      b.state = 'collapsing'; b.hp = Math.min(b.hp, 0); smoking.delete(id); removeBuilding(grid, id);
      const { piece, meshes } = extract(b); throwDebris(b); falling.push({ b, piece, meshes, t: 0, dustDebt: 0 });
      emit('collapse', b); return true;
    },
    /** Put every building back as it was. */
    restore() {
      for (const f of falling) { live.remove(f.piece); for (const m of f.meshes) m.geometry.dispose(); }
      falling.length = 0; for (const d of debris) live.remove(d.m); debris.length = 0;
      for (const m of rubble.values()) { live.remove(m); m.dispose(); m.material.dispose(); } rubble.clear();
      for (const m of scorches.values()) { live.remove(m); m.geometry.dispose(); m.material.dispose(); } scorches.clear();
      for (const p of dust) { p.s.visible = false; p.age = 9; }
      wallIndex.array.set(wallIndex0); roofIndex.array.set(roofIndex0); wallIndex.needsUpdate = true; roofIndex.needsUpdate = true;
      restoreBuildings(grid); smoking.clear();
      for (const b of info.values()) { b.hp = b.maxHp; b.state = 'standing'; showDamage(b); }
      for (const b of info.values()) emit('restore', b);
    },
    /** Step the animation: collapses, debris, dust, smoke from damaged buildings. */
    update(dt) {
      for (let i = falling.length - 1; i >= 0; i--) {
        const f = falling[i], { b } = f; f.t += dt;
        const u = Math.max(0, (f.t - SHAKE_S) / (COLLAPSE_S - SHAKE_S)), s = 1 - 0.88 * u * u, shake = f.t < SHAKE_S ? 0.18 * Math.sin(f.t * 70) : 0.1 * (1 - u) * Math.sin(f.t * 55);
        f.piece.scale.y = s; f.piece.position.set(shake, b.baseY * (1 - s), shake * 0.7);
        f.dustDebt += dt * Math.min(140, 40 + 6 * Math.sqrt(b.area)) * (f.t < SHAKE_S ? 0.25 : 1);
        for (; f.dustDebt >= 1; f.dustDebt--) {                              // dust rolls out from the footprint's edge and rises
          const a = random() * Math.PI * 2, out = rand(0.5, 1) * b.radius;
          puff(b.x + Math.cos(a) * out, b.baseY + rand(0.3, 1.5), b.z + Math.sin(a) * out, Math.cos(a) * rand(1, 4), rand(1.5, 4), Math.sin(a) * rand(1, 4), rand(1.2, 2.2), rand(1.2, 3));
        }
        if (f.t >= COLLAPSE_S) { live.remove(f.piece); for (const m of f.meshes) m.geometry.dispose(); falling.splice(i, 1); b.state = 'rubble'; makeRubble(b); emit('rubble', b); }
      }
      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i]; d.age += dt;
        if (d.age >= d.life) { live.remove(d.m); debris.splice(i, 1); continue; }
        d.vy -= GRAVITY * dt; d.m.position.x += d.vx * dt; d.m.position.y += d.vy * dt; d.m.position.z += d.vz * dt; d.m.rotation.x += d.sx * dt; d.m.rotation.z += d.sz * dt;
        const g = groundY(d.m.position.x, d.m.position.z) + 0.2;
        if (d.m.position.y < g) { d.m.position.y = g; d.vx *= 0.5; d.vz *= 0.5; d.sx *= 0.4; d.sz *= 0.4; d.vy = Math.abs(d.vy) < 2 ? 0 : -d.vy * 0.35; }
        if (d.age > d.life - 0.3) d.m.scale.multiplyScalar(0.9);
      }
      for (const id of smoking) {                                            // a badly hurt building smokes from its roof
        const b = info.get(id), rate = 3 + 8 * (b.level - SMOKE_FROM) / (1 - SMOKE_FROM), due = (b.smokeDebt ?? 0) + rate * dt, n = Math.floor(due); b.smokeDebt = due - n;
        for (let i = 0; i < n; i++) puff(b.x + rand(-0.4, 0.4) * b.radius, b.baseY + b.height + 0.3, b.z + rand(-0.4, 0.4) * b.radius, rand(-0.5, 0.5), rand(2, 3.5), rand(-0.5, 0.5), rand(1.6, 2.4), rand(1, 2));
      }
      for (const p of dust) {
        if (!p.s.visible) continue;
        p.age += dt; if (p.age >= p.life) { p.s.visible = false; continue; }
        const k = p.age / p.life, pos = p.s.position; pos.x += p.vx * dt; pos.y += p.vy * dt; pos.z += p.vz * dt; p.vx *= Math.exp(-1.2 * dt); p.vz *= Math.exp(-1.2 * dt); p.vy *= Math.exp(-0.6 * dt);
        p.s.material = dustMats[Math.min(DUST.length - 1, Math.floor(k * DUST.length))]; p.s.scale.setScalar(Math.max(0.4, Math.round((p.size * (0.5 + 1.2 * k)) / 0.4) * 0.4));
      }
    },
  };
  return api;
}
