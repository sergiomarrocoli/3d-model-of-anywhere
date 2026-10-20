// The viewer: pick an area on a map, build it, fly around it. Modules talk only through the flow context (modules/flow).
//   modules/picker    pick   choose an area on an open map              -> ctx.bbox
//   modules/builder   build  ask the build service for it and wait      -> ctx.area, ctx.bundleUrl
//   view              load the map (modules/map) and fly a free camera round it; the credits (modules/credits) list the sources
// URLs: /  views the default area;  ?area=<id>  views that one;  ?pick  is ?flow=pick,build,view;  ?debug  inspects a bundle;
//       ?landcover  tints the ground by land cover (press L to toggle).
import * as THREE from 'three';
import { buildStep } from '@builder';
import { mountCredits } from '@credits';
import { FlowError, parseFlow, runFlow, urlAfterBuild } from '@flow';
import { createFlyCamera, debugMain, listMaps, loadMap } from '@map';

const $ = (id) => document.getElementById(id);
const DEFAULT_AREA = 'newtown';
const BUNDLES = `${import.meta.env.BASE_URL}bundles`;      // where the areas are served from (a built copy may live under a sub-path)
const DEMO = Boolean(import.meta.env.VITE_DEMO);           // the hosted demo has no build service: no picking, no debug page

async function viewArea(area) {
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const map = await loadMap(`${BUNDLES}/area_${area}`, { renderer });
  scene.add(map.object);
  mountCredits($('credits'), map.attribution);
  if (new URLSearchParams(location.search).has('landcover')) map.showLandcover(true);
  addEventListener('keydown', (e) => { if (e.key === 'l' || e.key === 'L') map.showLandcover(); });
  const [W, D] = map.size;

  const camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
  const fly = createFlyCamera(camera, canvas, { position: new THREE.Vector3(W * 0.5, W * 0.45, -D * 0.5 + W * 0.45), lookAt: new THREE.Vector3(W / 2, 0, -D / 2), speed: W / 8 });
  const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => { const dt = Math.min(clock.getDelta(), 0.1); fly.update(dt); map.update(dt); renderer.render(scene, camera); });
  window.__app = { THREE, scene, camera, renderer, map, meta: map.meta }; // for console poking
  document.title = `uk-map-3d: ${map.meta.id}`;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const areas = await listMaps(BUNDLES);
  const area = params.get('area') ?? (areas.includes(DEFAULT_AREA) ? DEFAULT_AREA : areas[0]);
  const links = areas.map((a) => `<a href="?area=${a}"${a === area ? ' class="on"' : ''}>${a}</a>`).join(' ');
  $('areas').innerHTML = DEMO ? `${links} <span class="hint">WASD to move, Q/E down/up, Shift to speed up, drag to look, wheel for speed</span>`
    : links + ' <a href="?pick">pick area</a> <a href="?debug&area=' + area + '">debug</a>';
  if (!DEMO && params.has('debug')) { document.body.classList.add('debug'); return debugMain(); }
  if (!areas.length && !params.has('pick') && !params.has('flow')) throw new Error('no areas built yet: open ?pick to choose one, or run build_area.py');

  const registry = {
    pick: { name: 'pick', run: (ctx, host) => import('@picker').then((m) => m.pickStep.run(ctx, host)) },   // loaded only when used: MapLibre is large
    build: buildStep,
    view: { name: 'view', async run(ctx) {
      const id = ctx.area ?? area;
      if (ctx.bundleUrl) history.replaceState(null, '', urlAfterBuild(location.href, id));   // an area was just built: a refresh views it
      $('flow').hidden = true; document.body.classList.remove('flow');
      await viewArea(id);
      return { ...ctx, area: id };
    } },
  };
  const names = parseFlow(params, Object.keys(registry), { default: ['view'], pick: ['pick', 'build', 'view'] });
  if (names[0] !== 'view') document.body.classList.add('flow');
  const ctl = new AbortController();
  await runFlow(names, registry, params.has('area') ? { area } : {}, () => { const root = $('flow'); root.hidden = false; root.innerHTML = ''; root.className = ''; return { root, signal: ctl.signal }; });
}

main().catch((e) => {
  document.body.classList.remove('flow'); $('flow').hidden = true;
  const text = e instanceof FlowError ? `Flow: ${e.message}` : `Error: ${e.message}`;
  $('credits').textContent = text; $('error').textContent = text; $('error').hidden = false;   // in the middle of the screen, not just the footer
  console.error(e);
});
