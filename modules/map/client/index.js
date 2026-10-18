// Map module, client side: load a built area (a "bundle") and expose it as a drawable scene plus the questions a game
// needs to ask about it. Everything is in world coordinates (X east, Y up, Z = -north, Y measured from the lowest
// ground in the area), so a game never touches the bundle's local x/y or the heightmap rows.
import * as THREE from 'three';
import { loadBundle } from './bundle.js';
import { buildBuildings } from './buildings.js';
import { createDestruction, RUBBLE_SLOWDOWN } from './destruction.js';
import { buildCollisionGrid, insideBuilding, PLAYER_RADIUS, resolveCircle } from './collision.js';
import { zRef } from './coords.js';
import { clampToBox } from './edge.js';
import { sampleHeight } from './heightmap.js';
import { landcoverPixels, surfaceIdAt, surfaceInfo } from './landcover.js';
import { rayHeightfield } from './raycast.js';
import { resolveSlope, speedFactor } from './slope.js';
import { buildTerrain } from './terrain.js';

export { createFlyCamera } from './flycam.js';
export { SURFACE, SURFACE_COLOURS, SURFACE_NAMES } from './landcover.js';
export const debugMain = (...args) => import('./debug.js').then((m) => m.debugMain(...args)); // bundle inspector page (?debug)

/** Ids of the areas the server has built. */
export async function listMaps(base = '/bundles') {
  return (await fetch(`${base}/index.json`)).json();
}

/** Fetch an area and build it. `renderer` is only used to pick texture filtering. */
export async function loadMap(baseUrl, { renderer = null } = {}) {
  return createMap(await loadBundle(baseUrl), { renderer });
}

/**
 * Build a map from an already loaded bundle. Returns:
 *   object            THREE.Group to add to a scene: terrain, buildings and the lights they are meant to be seen under
 *   meta, attribution bundle metadata and the credit lines to display
 *   size              [width, depth] in metres; the map spans X 0..W and Z -D..0
 *   groundY(x, z)     ground height (bilinear), world units
 *   raycastGround(origin, dir, opts)   where a ray meets the ground (Vector3 or null)
 *   isSolid(x, z)     is the point inside a building
 *   pushOutOfBuildings(x, z, r)        nearest position at least r from every building (slides along walls)
 *   limitSlope(x0, z0, x1, z1)         the part of a move that is allowed: only near-vertical ground blocks
 *   slopeSpeedFactor(x0, z0, dx, dz)   1 on the level or downhill, less going uphill
 *   clamp(x, z)       keep a point inside the map
 *   surfaceAt(x, z)   what the ground is: { id, name } from SURFACE_NAMES (road, paved, grass, bare, tree, water, building, unknown); surfaceIdAt is the same as a bare id
 *   hasLandcover, showLandcover(on)    whether the bundle has the layer, and a tint overlay of it (no argument toggles)
 * and the buildings can be knocked down (see destruction.js):
 *   damageBuilding(id, amount), damageBuildingAt(x, z, amount, reach), blast(x, z, radius, amount), buildingAt(x, z, reach), restoreBuildings(), onBuilding(fn), update(dt), rubbleAt(x, z)
 */
export function createMap(bundle, { renderer = null } = {}) {
  const { meta, heightmap, surface, imagery, buildings, landcover = null } = bundle;
  const [W, D] = meta.size_m;
  const ref = zRef(meta);
  const solid = buildCollisionGrid(buildings);

  const object = new THREE.Group();
  object.name = 'map';
  const terrain = buildTerrain(meta, heightmap, imagery, renderer);
  object.add(terrain);
  const buildingGroup = buildBuildings(meta, buildings, terrain.material.map, surface, renderer);
  object.add(buildingGroup);                                                       // roofs share the terrain's imagery texture
  // One directional "sun", no shadows (the imagery already has baked ones). Only walls are lit; roofs and
  // terrain are unlit imagery. A little ambient keeps shaded walls from going black.
  object.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.3);
  sun.position.set(-200, 300, 150);
  object.add(sun);

  const groundY = (x, z) => sampleHeight(heightmap, x, -z) - ref;
  let tint = null;                                                                 // the land cover overlay, built the first time it is asked for
  const showLandcover = (on) => {
    if (!landcover) return false;
    if (!tint) {
      const canvas = document.createElement('canvas'); canvas.width = landcover.width; canvas.height = landcover.height;
      canvas.getContext('2d').putImageData(new ImageData(landcoverPixels(landcover, 150), landcover.width, landcover.height), 0, 0);
      const tex = new THREE.CanvasTexture(canvas); tex.flipY = false; tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      tint = new THREE.Mesh(terrain.geometry, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      tint.name = 'landcover'; tint.visible = false; object.add(tint);
    }
    tint.visible = on ?? !tint.visible;
    return tint.visible;
  };
  const destruction = createDestruction({ meta, buildings, grid: solid, group: buildingGroup, groundY });
  return {
    meta, attribution: meta.attribution, size: [W, D], object, terrain, groundY, destruction,
    damageBuilding: destruction.damage, damageBuildingAt: destruction.damageAt, blast: destruction.blast, buildingAt: destruction.buildingAt, rubbleAt: destruction.rubbleAt,
    restoreBuildings: destruction.restore, onBuilding: destruction.on, update: destruction.update,
    raycastGround: (origin, dir, opts = {}) => rayHeightfield(origin, dir, groundY, opts),
    isSolid: (x, z) => insideBuilding(solid, x, -z),
    pushOutOfBuildings(x, z, r = PLAYER_RADIUS) { const p = resolveCircle(solid, x, -z, r); return { x: p.x, z: -p.y }; },
    limitSlope(x0, z0, x1, z1) { const p = resolveSlope(heightmap, x0, -z0, x1, -z1); return { x: p.x, z: -p.y }; },
    slopeSpeedFactor: (x0, z0, dx, dz) => speedFactor(heightmap, x0, -z0, dx, -dz) * (destruction.rubbleAt(x0 + dx, z0 + dz) ? RUBBLE_SLOWDOWN : 1),   // rubble slows you
    clamp: (x, z) => clampToBox(x, z, W, D),
    surfaceIdAt: (x, z) => surfaceIdAt(landcover, x, -z), surfaceAt: (x, z) => surfaceInfo(surfaceIdAt(landcover, x, -z)),
    hasLandcover: !!landcover, showLandcover,
  };
}
