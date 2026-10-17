// Map module, client side: load a built area (a "bundle") and expose it as a drawable scene plus the questions a game
// needs to ask about it. Everything is in world coordinates (X east, Y up, Z = -north, Y measured from the lowest
// ground in the area), so a game never touches the bundle's local x/y or the heightmap rows.
import * as THREE from 'three';
import { loadBundle } from './bundle.js';
import { buildBuildings } from './buildings.js';
import { buildCollisionGrid, insideBuilding, PLAYER_RADIUS, resolveCircle } from './collision.js';
import { zRef } from './coords.js';
import { clampToBox } from './edge.js';
import { sampleHeight } from './heightmap.js';
import { rayHeightfield } from './raycast.js';
import { resolveSlope, speedFactor } from './slope.js';
import { buildTerrain } from './terrain.js';

export { createFlyCamera } from './flycam.js';
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
 */
export function createMap(bundle, { renderer = null } = {}) {
  const { meta, heightmap, surface, imagery, buildings } = bundle;
  const [W, D] = meta.size_m;
  const ref = zRef(meta);
  const solid = buildCollisionGrid(buildings);

  const object = new THREE.Group();
  object.name = 'map';
  const terrain = buildTerrain(meta, heightmap, imagery, renderer);
  object.add(terrain);
  object.add(buildBuildings(meta, buildings, terrain.material.map, surface, renderer)); // roofs share the terrain's imagery texture
  // One directional "sun", no shadows (the imagery already has baked ones). Only walls are lit; roofs and
  // terrain are unlit imagery. A little ambient keeps shaded walls from going black.
  object.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.3);
  sun.position.set(-200, 300, 150);
  object.add(sun);

  const groundY = (x, z) => sampleHeight(heightmap, x, -z) - ref;
  return {
    meta, attribution: meta.attribution, size: [W, D], object, terrain, groundY,
    raycastGround: (origin, dir, opts = {}) => rayHeightfield(origin, dir, groundY, opts),
    isSolid: (x, z) => insideBuilding(solid, x, -z),
    pushOutOfBuildings(x, z, r = PLAYER_RADIUS) { const p = resolveCircle(solid, x, -z, r); return { x: p.x, z: -p.y }; },
    limitSlope(x0, z0, x1, z1) { const p = resolveSlope(heightmap, x0, -z0, x1, -z1); return { x: p.x, z: -p.y }; },
    slopeSpeedFactor: (x0, z0, dx, dz) => speedFactor(heightmap, x0, -z0, dx, -dz),
    clamp: (x, z) => clampToBox(x, z, W, D),
  };
}
