// Picker module, client side: an open map (OpenStreetMap tiles in MapLibre) with a draggable, resizable box. The box is
// kept in British National Grid metres, so it is exactly the area the map builder will build.
//   createPicker(...)     the map and the box only
//   mountPickerPage(...)  a full page around it: search, size readout, GB check, the build command
import { Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'; // MapLibre's worker must be served by the bundler, not found by guesswork
import 'maplibre-gl/dist/maplibre-gl.css';
import './picker.css';
import { fromBNG, insideGB, toBNG } from './bng.js';
import { HANDLES, boxBBox, boxCentre, boxCorners, boxSize, buildCommand, DEFAULT_SIZE_M, handleCursor, handlePosition, makeBox, MAX_SIZE_M, MIN_SIZE_M, moveBox, recentreBox, resizeBox } from './box.js';
import { geocode } from './geocode.js';

export { DEFAULT_SIZE_M, MAX_SIZE_M, MIN_SIZE_M } from './box.js';

setWorkerUrl(workerUrl);

const OSM_STYLE = {
  version: 8,
  sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};
const START = { lon: -3.3136, lat: 52.513 }; // Newtown, Powys

const ring = (box) => { const pts = boxCorners(box).map(([e, n]) => fromBNG(e, n)); return [...pts, pts[0]]; };
const polygon = (box) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(box)] } }] });

/**
 * @param {object} o
 * @param {HTMLElement} o.container       element the map fills
 * @param {{lon:number,lat:number}} [o.centre]   where to start (default Newtown)
 * @param {object} [o.box]                start box in grid metres (default 1 km around the centre)
 * @param {number} [o.zoom]
 * @param {(box:object)=>void} [o.onChange]     fires whenever the box moves or resizes
 * @returns {{ map, getBox(), setBox(box), centreOnView(), flyTo(lon, lat), destroy() }}
 */
export function createPicker({ container, centre = START, box = null, zoom = 14, onChange = () => {} }) {
  let current = box ?? makeBox(toBNG(centre.lon, centre.lat), DEFAULT_SIZE_M);
  const map = new MapLibreMap({ container, style: OSM_STYLE, center: box ? fromBNG(...boxCentre(box)) : [centre.lon, centre.lat], zoom, attributionControl: { compact: true } });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-left');

  const markers = new Map();
  const pointerToGrid = (e) => {
    const r = map.getCanvas().getBoundingClientRect();
    const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
    return toBNG(ll.lng, ll.lat);
  };

  const render = () => {
    map.getSource('box')?.setData(polygon(current));
    for (const h of HANDLES) markers.get(h)?.setLngLat(fromBNG(...handlePosition(current, h)));
  };
  const set = (b) => { current = b; render(); onChange(current); };

  // Dragging a handle (resize) or the body of the box (move). While dragging, the map does not pan.
  const startDrag = (e, target, onMove) => {
    e.preventDefault(); e.stopPropagation();
    map.dragPan.disable();
    target.setPointerCapture?.(e.pointerId);
    const move = (ev) => onMove(pointerToGrid(ev));
    const up = () => { map.dragPan.enable(); target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  };

  map.on('load', () => {
    map.addSource('box', { type: 'geojson', data: polygon(current) });
    map.addLayer({ id: 'box-fill', type: 'fill', source: 'box', paint: { 'fill-color': '#2b6cb0', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'box-line', type: 'line', source: 'box', paint: { 'line-color': '#2b6cb0', 'line-width': 2.5 } });
    for (const h of HANDLES) {
      const el = document.createElement('div');
      el.className = 'picker-handle'; el.style.cursor = handleCursor(h); el.dataset.handle = h;
      el.addEventListener('pointerdown', (e) => {
        const start = current;
        startDrag(e, el, ([E, N]) => set(resizeBox(start, h, E, N)));
      });
      markers.set(h, new Marker({ element: el }).setLngLat(fromBNG(...handlePosition(current, h))).addTo(map));
    }
    onChange(current);
  });

  // Move the box by grabbing its body (the filled area). Done on the canvas, using the map's own hit test.
  const canvas = map.getCanvas();
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !map.getLayer('box-fill')) return;
    const r = canvas.getBoundingClientRect();
    if (!map.queryRenderedFeatures([e.clientX - r.left, e.clientY - r.top], { layers: ['box-fill'] }).length) return;
    const start = current, [E0, N0] = pointerToGrid(e);
    startDrag(e, canvas, ([E, N]) => set(moveBox(start, E - E0, N - N0)));
  }, true);
  // Click the map (not a drag) to put the box there, keeping its size, so after panning away you can bring it along.
  // Clicks on the box itself, and the end of a handle drag, do not count.
  map.doubleClickZoom.disable();
  map.on('click', (e) => {
    if (e.originalEvent.target.closest?.('.picker-handle')) return;
    if (map.getLayer('box-fill') && map.queryRenderedFeatures(e.point, { layers: ['box-fill'] }).length) return;
    set(recentreBox(current, toBNG(e.lngLat.lng, e.lngLat.lat)));
  });
  const centreOnView = () => { const c = map.getCenter(); set(recentreBox(current, toBNG(c.lng, c.lat))); };
  map.on('mousemove', (e) => { canvas.style.cursor = map.getLayer('box-fill') && map.queryRenderedFeatures(e.point, { layers: ['box-fill'] }).length ? 'move' : ''; });

  return {
    map,
    getBox: () => current,
    setBox: set,
    centreOnView,
    flyTo: (lon, lat, z = 14) => map.flyTo({ center: [lon, lat], zoom: z }),
    destroy: () => map.remove(),
  };
}

const fmt = (n) => Math.round(n).toLocaleString('en-GB');
const STORE = 'cw-picker-box';

/**
 * A full page: the map, a search box (postcode or place), the box size and grid reference, a warning outside
 * Great Britain, and the command that builds the area. `onBuild(box)` is called by the Build button if given.
 */
export function mountPickerPage(root, { onBuild = null, initial = null } = {}) {
  root.classList.add('picker'); root.hidden = false;
  root.innerHTML = `
    <div class="picker-map"><div data-map></div></div>
    <div class="picker-side">
      <h2>Pick an area</h2>
      <form data-search class="row"><input type="text" placeholder="postcode or place" aria-label="search" /><button type="submit" class="secondary">Go</button></form>
      <div data-msg class="hint"></div>
      <button type="button" class="secondary" data-here>Move the box to the middle of the map</button>
      <div class="stat" data-size></div>
      <div class="stat" data-grid></div>
      <div class="warn" data-warn hidden>This box is outside the Ordnance Survey grid (Great Britain). The data sources only cover Great Britain.</div>
      <div class="row"><button data-build>Build this area</button></div>
      <div class="hint" data-buildmsg></div>
      <details><summary class="hint">Build it from the command line</summary><code data-cmd></code><button class="secondary" data-copy style="margin-top:6px">Copy</button></details>
      <div class="hint">Drag the box to move it, click the map to put it there, drag its handles to resize it (${MIN_SIZE_M / 1000} to ${MAX_SIZE_M / 1000} km a side). The box follows the Ordnance Survey grid, which is why it can look slightly turned against the map.</div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  let saved = initial;
  if (!saved) { try { saved = JSON.parse(localStorage.getItem(STORE)); } catch { /* none */ } }
  const picker = createPicker({
    container: $('[data-map]'), box: saved,
    onChange: (b) => {
      const { width, height } = boxSize(b), [cE, cN] = boxCentre(b);
      $('[data-size]').textContent = `${fmt(width)} × ${fmt(height)} m  (${((width * height) / 1e6).toFixed(2)} km²)`;
      $('[data-grid]').textContent = `centre E ${fmt(cE)}  N ${fmt(cN)}`;
      $('[data-warn]').hidden = insideGB(boxBBox(b));
      $('[data-cmd]').textContent = buildCommand(b);
      $('[data-build]').disabled = !onBuild || !insideGB(boxBBox(b));
      try { localStorage.setItem(STORE, JSON.stringify(b)); } catch { /* private mode */ }
    },
  });
  $('[data-buildmsg]').textContent = onBuild ? '' : 'The Build button arrives with the build service; for now copy the command below.';
  $('[data-here]').onclick = () => picker.centreOnView();
  $('[data-build]').onclick = () => onBuild?.(picker.getBox());
  $('[data-copy]').onclick = () => navigator.clipboard?.writeText($('[data-cmd]').textContent);
  $('[data-search]').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.querySelector('input').value;
    $('[data-msg]').textContent = 'searching…';
    try {
      const hit = await geocode(q);
      if (!hit) { $('[data-msg]').textContent = 'not found'; return; }
      $('[data-msg]').textContent = hit.label;
      picker.setBox(makeBox(toBNG(hit.lon, hit.lat), boxSize(picker.getBox()).width));
      picker.flyTo(hit.lon, hit.lat);
    } catch { $('[data-msg]').textContent = 'search failed (offline?)'; }
  };
  return picker;
}

/**
 * Flow step: shows the picker page in host.root and resolves when the user presses Build, adding the box to the
 * context as ctx.bbox ([minE, minN, maxE, maxN], whole metres) and ctx.box ({ minE, minN, maxE, maxN }).
 */
export const pickStep = {
  name: 'pick',
  run: (ctx, host) => new Promise((resolve) => {
    const picker = mountPickerPage(host.root, {
      initial: ctx.box ?? null,
      onBuild: (box) => {
        picker.destroy(); host.root.innerHTML = ''; host.root.className = '';
        resolve({ ...ctx, box, bbox: boxBBox(box).map(Math.round) });
      },
    });
  }),
};
