// 2D circle-vs-polygon collision against building footprints, in bundle-local metres (x east, y north).
// A uniform grid indexes the footprints so each query only looks at the few buildings near the player. A building can be taken out of
// the grid when it collapses (`removeBuilding`) and put back (`restoreBuildings`); a collapsed one is rubble, which `insideRubble` finds.

export const PLAYER_RADIUS = 0.45;
const CELL = 16;

const openRing = (ring) => {
  const n = ring.length;
  return n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? ring.slice(0, -1) : ring;
};

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nearest point on a closed ring's boundary to (x, y): { px, py, d2 }. */
function nearestOnRing(x, y, ring, best) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy, d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 < best.d2) { best.d2 = d2; best.px = px; best.py = py; }
  }
  return best;
}

/** Build the index from a GeoJSON FeatureCollection of Polygons. */
export function buildCollisionGrid(buildings, cell = CELL) {
  const polys = [], cells = new Map();
  for (const [index, f] of buildings.features.entries()) {
    if (f.geometry?.type !== 'Polygon') continue;
    const rings = f.geometry.coordinates.map(openRing).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of rings[0]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const id = polys.length;
    polys.push({ id: index, rings, minX, minY, maxX, maxY, standing: true });      // id: where the building is in the feature list
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++)
      for (let cy = Math.floor(minY / cell); cy <= Math.floor(maxY / cell); cy++) {
        const k = `${cx},${cy}`;
        (cells.get(k) ?? cells.set(k, []).get(k)).push(id);
      }
  }
  return { polys, cells, cell };
}

function nearby(grid, x, y, r, standing = true) {
  const { cell, cells, polys } = grid, ids = new Set();
  for (let cx = Math.floor((x - r) / cell); cx <= Math.floor((x + r) / cell); cx++)
    for (let cy = Math.floor((y - r) / cell); cy <= Math.floor((y + r) / cell); cy++)
      for (const id of cells.get(`${cx},${cy}`) ?? []) ids.add(id);
  return [...ids].map((i) => polys[i]).filter((p) => p.standing === standing);
}

const insidePoly = (p, x, y) => x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY && pointInRing(x, y, p.rings[0]) && !p.rings.slice(1).some((h) => pointInRing(x, y, h));

/** Is the point inside this grid entry's footprint (courtyards excluded)? For placing rubble. */
export const insideEntry = (entry, x, y) => insidePoly(entry, x, y);

/** The grid's entry for the building with this id (its place in the feature list), or undefined. */
export const buildingEntry = (grid, id) => (grid.byId ??= new Map(grid.polys.map((p) => [p.id, p]))).get(id);

/** Take a building out of the grid: cars and people no longer hit it, and it counts as rubble. Returns whether it was standing. */
export function removeBuilding(grid, id) { const p = buildingEntry(grid, id); if (!p?.standing) return false; p.standing = false; return true; }

/** Put every collapsed building back. */
export function restoreBuildings(grid) { for (const p of grid.polys) p.standing = true; }

/** True if the point is on the rubble of a collapsed building. */
export function insideRubble(grid, x, y) { return nearby(grid, x, y, 0, false).some((p) => insidePoly(p, x, y)); }

/**
 * The standing buildings within `radius` of (x, y): [{ id, d }], nearest first, d the distance to the footprint's edge (0 inside it).
 */
export function buildingsNear(grid, x, y, radius) {
  const out = [];
  for (const p of nearby(grid, x, y, radius)) {
    if (x + radius < p.minX || x - radius > p.maxX || y + radius < p.minY || y - radius > p.maxY) continue;
    const best = { d2: Infinity, px: 0, py: 0 };
    for (const ring of p.rings) nearestOnRing(x, y, ring, best);
    const d = insidePoly(p, x, y) ? 0 : Math.sqrt(best.d2);
    if (d <= radius) out.push({ id: p.id, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** True if the point is inside a building (inside the outer ring and not in a courtyard hole). */
export function insideBuilding(grid, x, y) {
  return nearby(grid, x, y, 0).some((p) => insidePoly(p, x, y));
}

/**
 * Push a circle out of any footprint it overlaps and return the corrected centre. Sliding falls out of this
 * naturally: only the component of motion into the wall is removed. A few passes settle corners.
 */
export function resolveCircle(grid, x, y, r = PLAYER_RADIUS) {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const p of nearby(grid, x, y, r)) {
      if (x + r < p.minX || x - r > p.maxX || y + r < p.minY || y - r > p.maxY) continue;
      const best = { d2: Infinity, px: 0, py: 0 };
      for (const ring of p.rings) nearestOnRing(x, y, ring, best);
      const inside = pointInRing(x, y, p.rings[0]) && !p.rings.slice(1).some((h) => pointInRing(x, y, h));
      const d = Math.sqrt(best.d2);
      if (!inside && d >= r) continue;
      // direction from the wall out toward free space
      let nx, ny;
      if (d < 1e-9) { nx = 0; ny = 1; }
      else { nx = (x - best.px) / d; ny = (y - best.py) / d; if (inside) { nx = -nx; ny = -ny; } }
      x = best.px + nx * r; y = best.py + ny * r; // end up exactly r outside the boundary
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y };
}
