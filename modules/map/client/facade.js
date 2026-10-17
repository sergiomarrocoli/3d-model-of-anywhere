// What a building's walls look like, decided from its OSM tags and size, with no screen in it. The wall shader (buildings.js) draws the result: a
// grid of windows, doors, a shopfront, brick, stone or render. Anything the tags do not say is a guess from the building's type and height.

export const MATERIALS = { auto: -1, brick: 0, stone: 1, render: 2, cladding: 3 };
export const WINDOWS = { none: 0, domestic: 1, large: 2, tall: 3 };   // window styles: none, a normal house window, big office/flat windows, tall narrow (church)

export const MIN_WINDOWED_HEIGHT_M = 3.2;   // lower than this (a shed, a garage) and there are no windows
const FLOOR_M = { domestic: 2.8, large: 3.4, tall: 6, none: 4 };

const NAMED = {
  red: [0.62, 0.22, 0.18], brown: [0.45, 0.3, 0.2], white: [0.93, 0.92, 0.88], grey: [0.55, 0.55, 0.55], gray: [0.55, 0.55, 0.55], black: [0.15, 0.15, 0.16],
  yellow: [0.85, 0.75, 0.45], beige: [0.8, 0.74, 0.6], cream: [0.9, 0.86, 0.7], orange: [0.8, 0.5, 0.25], pink: [0.85, 0.65, 0.65], blue: [0.4, 0.5, 0.7],
  green: [0.4, 0.55, 0.4], tan: [0.75, 0.65, 0.5], stone: [0.65, 0.6, 0.5], brick: [0.55, 0.28, 0.2],
};

/** An OSM colour tag ('red', '#a0522d', '#a52') -> [r, g, b] in 0..1, or null if it is not one we know. */
export function parseColour(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/** The material a `building:material` tag names, or auto (the shader decides from the colour of the imagery). */
export function materialOf(tag) {
  const t = String(tag ?? '').toLowerCase();
  if (/brick/.test(t)) return MATERIALS.brick;
  if (/stone|sandstone|limestone|granite|slate|rock/.test(t)) return MATERIALS.stone;
  if (/plaster|render|stucco|concrete|cement|painted|plastered|masonry|mortar/.test(t)) return MATERIALS.render;
  if (/metal|steel|glass|aluminium|aluminum|timber|wood|cladding|corrugated/.test(t)) return MATERIALS.cladding;
  return MATERIALS.auto;
}

/** A stable number in [0, 1) from a string (an OSM id), so a building looks the same every time and its neighbours differ. */
export function hashSeed(str) {
  let h = 2166136261;
  for (const c of String(str ?? '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

const DOMESTIC = /^(yes|house|detached|semidetached_house|terrace|residential|bungalow|cabin|farm|dormitory|static_caravan)$/;
const LARGE = /^(apartments|commercial|office|retail|hotel|hospital|school|university|college|civic|public|government|supermarket|kindergarten|train_station|transportation)$/;
const TALL = /^(church|chapel|cathedral|mosque|temple|synagogue|religious|monastery|shrine)$/;
const NONE = /^(industrial|warehouse|garage|garages|shed|roof|service|barn|stable|cowshed|greenhouse|hangar|carport|boathouse|storage_tank|silo|ruins|construction|farm_auxiliary|sty|parking|toilets|transformer_tower|container)$/;

/**
 * The look of one building.
 * props: its feature properties (building, building:levels, building:material, building:colour, shop, amenity, osm_id, height).
 * Returns { material, windows, floorHeight, shopfront, seed, tint: [r, g, b, strength] } with floorHeight in metres, shopfront 0/1, strength 0 when no colour is tagged.
 */
export function facadeLook(props, height = props?.height) {
  const p = props ?? {}, type = String(p.building ?? 'yes').toLowerCase(), h = Number.isFinite(+height) ? +height : 6;
  let windows = TALL.test(type) ? WINDOWS.tall : NONE.test(type) ? WINDOWS.none : LARGE.test(type) ? WINDOWS.large : WINDOWS.domestic;
  if (windows !== WINDOWS.none && h < MIN_WINDOWED_HEIGHT_M) windows = WINDOWS.none;
  if (windows === WINDOWS.domestic && (h > 15 || p.amenity === 'hotel')) windows = WINDOWS.large;                 // a tall plain building is a block, not a house
  const levels = Math.floor(+p['building:levels']);
  const natural = FLOOR_M[Object.keys(WINDOWS).find((k) => WINDOWS[k] === windows)];
  const floorHeight = levels > 0 && windows !== WINDOWS.tall ? Math.min(4.5, Math.max(2.4, h / levels)) : natural;
  const colour = parseColour(p['building:colour']);
  const shopfront = (p.shop && p.shop !== 'no') || /^(retail|supermarket)$/.test(type) || /^(pub|bar|cafe|restaurant|fast_food|bank|pharmacy|bicycle_rental)$/.test(p.amenity ?? '') ? 1 : 0;
  return {
    material: materialOf(p['building:material']), windows, floorHeight, shopfront: windows === WINDOWS.none ? 0 : shopfront,
    seed: hashSeed(p.osm_id ?? JSON.stringify(p)), tint: colour ? [...colour, 1] : [0, 0, 0, 0],
  };
}
