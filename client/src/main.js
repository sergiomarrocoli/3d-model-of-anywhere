// The shell: chooses a flow of steps and plugs the modules together. Each module is separate and talks to the others
// only through the flow context (see flow.js), so another module can be slotted in between.
//   modules/picker    pick   choose an area on an open map                        -> ctx.bbox
//   modules/builder   build  ask the build service for it and wait                -> ctx.area, ctx.bundleUrl
//   modules/credits   a Credits button and overlay listing the sources the area used (used by play)
//   (a track drawer, say, could go here: reads ctx.area / ctx.bbox, adds ctx.overlay)
//   play              load the map (modules/map), run the game (modules/walker), friends (modules/presence)
// URLs: /  plays the default area;  ?area=<id>  plays that one;  ?pick  is ?flow=pick,build,play;  ?flow=a,b,c  runs steps a, b, c.
import * as THREE from 'three';
import { buildStep } from '@builder';
import { mountCredits } from '@credits';
import { createFlyCamera, debugMain, listMaps, loadMap } from '@map';
import { startPresence } from '@presence';
import { startWalker } from '@walker';
import { FlowError, parseFlow, runFlow, urlAfterBuild } from './flow.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_AREA = 'newtown';

async function playGame({ area, overlay = null }) {
  const params = new URLSearchParams(location.search);
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const map = await loadMap(`/bundles/area_${area}`, { renderer });
  scene.add(map.object);
  mountCredits($('credits'), map.attribution);
  const [W, D] = map.size;

  let camera, setAspect, step, walker = null, presence = null;
  if (params.has('fly')) { // debug free-fly camera (?fly)
    camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
    const fly = createFlyCamera(camera, canvas, { position: new THREE.Vector3(W * 0.5, W * 0.45, -D * 0.5 + W * 0.45), lookAt: new THREE.Vector3(W / 2, 0, -D / 2), speed: W / 8 });
    setAspect = (a) => { camera.aspect = a; camera.updateProjectionMatrix(); };
    step = (dt) => fly.update(dt);
  } else {
    walker = startWalker({ map, scene, canvas });
    presence = startPresence({ scene, localMesh: walker.player, groundY: map.groundY, overlay: $('players'), area, params });
    camera = walker.camera; setAspect = walker.setAspect;
    step = (dt) => { walker.update(dt); presence.update(dt, walker.me); };
  }

  const resize = () => { renderer.setSize(innerWidth, innerHeight, false); setAspect(innerWidth / innerHeight); };
  addEventListener('resize', resize); resize();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => { step(Math.min(clock.getDelta(), 0.1)); renderer.render(scene, camera); });
  window.__app = { THREE, scene, camera, renderer, map, walker, presence, overlay, player: walker?.player, meta: map.meta }; // for console poking
  document.title = `civil-war: ${map.meta.id}`;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const areas = await listMaps();
  const area = params.get('area') ?? (areas.includes(DEFAULT_AREA) ? DEFAULT_AREA : areas[0]);
  $('areas').innerHTML = areas.map((a) => `<a href="?area=${a}"${a === area ? ' class="on"' : ''}>${a}</a>`).join(' ') + ' <a href="?pick">pick area</a> <a href="?debug&area=' + area + '">debug</a>';
  if (params.has('debug')) { document.body.classList.add('debug'); return debugMain(); }
  if (!areas.length && !params.has('pick') && !params.has('flow')) throw new Error('no areas built yet: open ?pick to choose one, or run build_area.py');

  const registry = {
    pick: { name: 'pick', run: (ctx, host) => import('@picker').then((m) => m.pickStep.run(ctx, host)) },   // loaded only when used: MapLibre is large
    build: buildStep,
    play: { name: 'play', async run(ctx) {
      const id = ctx.area ?? area;
      if (ctx.bundleUrl) history.replaceState(null, '', urlAfterBuild(location.href, id));   // an area was just built: a refresh plays it
      $('flow').hidden = true; document.body.classList.remove('flow');
      await playGame({ area: id, overlay: ctx.overlay ?? null });
      return { ...ctx, area: id };
    } },
  };
  const names = parseFlow(params, Object.keys(registry));
  if (names[0] !== 'play') document.body.classList.add('flow');
  const ctl = new AbortController();
  await runFlow(names, registry, params.has('area') ? { area } : {}, () => { const root = $('flow'); root.hidden = false; root.innerHTML = ''; root.className = ''; return { root, signal: ctl.signal }; });
}

main().catch((e) => { document.body.classList.remove('flow'); $('flow').hidden = true; $('credits').textContent = e instanceof FlowError ? `Flow: ${e.message}` : `Error: ${e.message}`; console.error(e); });
