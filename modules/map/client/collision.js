// 2D circle-vs-polygon collision against building footprints, in bundle-local metres (x east, y north).
// A uniform grid indexes the footprints so each query only looks at the few buildings near the player.

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
  for (const f of buildings.features) {
    if (f.geometry?.type !== 'Polygon') continue;
    const rings = f.geometry.coordinates.map(openRing).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of rings[0]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const id = polys.length;
    polys.push({ rings, minX, minY, maxX, maxY });
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++)
      for (let cy = Math.floor(minY / cell); cy <= Math.floor(maxY / cell); cy++) {
        const k = `${cx},${cy}`;
        (cells.get(k) ?? cells.set(k, []).get(k)).push(id);
      }
  }
  return { polys, cells, cell };
}

function nearby(grid, x, y, r) {
  const { cell, cells, polys } = grid, ids = new Set();
  for (let cx = Math.floor((x - r) / cell); cx <= Math.floor((x + r) / cell); cx++)
    for (let cy = Math.floor((y - r) / cell); cy <= Math.floor((y + r) / cell); cy++)
      for (const id of cells.get(`${cx},${cy}`) ?? []) ids.add(id);
  return [...ids].map((i) => polys[i]);
}

/** True if the point is inside a building (inside the outer ring and not in a courtyard hole). */
export function insideBuilding(grid, x, y) {
  return nearby(grid, x, y, 0).some((p) => x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY &&
    pointInRing(x, y, p.rings[0]) && !p.rings.slice(1).some((h) => pointInRing(x, y, h)));
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
