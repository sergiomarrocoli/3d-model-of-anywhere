// The shell: chooses a flow of steps and plugs the modules together. Each module is separate and talks to the others
// only through the flow context (see flow.js), so another module can be slotted in between.
//   modules/picker    pick   choose an area on an open map                        -> ctx.bbox
//   modules/builder   build  ask the build service for it and wait                -> ctx.area, ctx.bundleUrl
//   modules/credits   a Credits button and overlay listing the sources the area used (used by play)
//   modules/track    track  draw a closed track on an overhead view, around buildings   -> ctx.overlay (a game draws or uses it)
//   play              load the map (modules/map), run the walker game (modules/walker), friends (modules/presence)
//   race              load the map and drive the track from ctx.overlay (modules/racer)
// URLs: /  plays the default area;  ?area=<id>  plays that one;  ?pick  is ?flow=pick,build,play;  ?flow=a,b,c  runs steps a, b, c,
//       e.g. ?flow=pick,build,track,play  or, on an area already built,  ?flow=track,race&area=newtown  (draw a track, then drive it)
import * as THREE from 'three';
import { buildStep } from '@builder';
import { mountCredits } from '@credits';
import { createFlyCamera, debugMain, listMaps, loadMap } from '@map';
import { startPresence } from '@presence';
import { startRacer } from '@racer';
import { buildTrackRibbon, trackStep } from '@track';
import { startWalker } from '@walker';
import { FlowError, parseFlow, runFlow, urlAfterBuild } from './flow.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_AREA = 'newtown';

async function playGame({ area, overlay = null, game = 'walker' }) {
  const params = new URLSearchParams(location.search);
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const map = await loadMap(`/bundles/area_${area}`, { renderer });
  scene.add(map.object);
  if (overlay?.type === 'track') scene.add(buildTrackRibbon(overlay, map.groundY));   // a track drawn in the track step
  mountCredits($('credits'), map.attribution);
  const [W, D] = map.size;

  let camera, setAspect, step, walker = null, presence = null, racer = null;
  if (params.has('fly')) { // debug free-fly camera (?fly)
    camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
    const fly = createFlyCamera(camera, canvas, { position: new THREE.Vector3(W * 0.5, W * 0.45, -D * 0.5 + W * 0.45), lookAt: new THREE.Vector3(W / 2, 0, -D / 2), speed: W / 8 });
    setAspect = (a) => { camera.aspect = a; camera.updateProjectionMatrix(); };
    step = (dt) => fly.update(dt);
  } else if (game === 'racer') { // drive the track drawn in the track step
    racer = startRacer({ map, scene, canvas, track: overlay, showCheckpoints: params.has('debugcheckpoints'), aiCars: Number(params.get('ai')) || 0 });   // ?debugcheckpoints draws the invisible gates, for debugging
    camera = racer.camera; setAspect = racer.setAspect;
    step = (dt) => racer.update(dt);
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
  window.__app = { THREE, scene, camera, renderer, map, walker, racer, presence, overlay, player: walker?.player, meta: map.meta }; // for console poking
  document.title = `civil-war: ${map.meta.id}`;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const areas = await listMaps();
  const area = params.get('area') ?? (areas.includes(DEFAULT_AREA) ? DEFAULT_AREA : areas[0]);
  $('areas').innerHTML = areas.map((a) => `<a href="?area=${a}"${a === area ? ' class="on"' : ''}>${a}</a>`).join(' ') + ' <a href="?pick">pick area</a> <a href="?debug&area=' + area + '">debug</a>';
  if (params.has('debug')) { document.body.classList.add('debug'); return debugMain(); }
  if (!areas.length && !params.has('pick') && !params.has('flow')) throw new Error('no areas built yet: open ?pick to choose one, or run build_area.py');

  // The last step of any flow: leave the flow screen and start a game on ctx.area (with ctx.overlay, if any).
  const finishFlow = async (ctx, game) => {
    const id = ctx.area ?? area;
    if (ctx.bundleUrl) history.replaceState(null, '', urlAfterBuild(location.href, id));   // an area was just built: a refresh plays it
    $('flow').hidden = true; document.body.classList.remove('flow');
    await playGame({ area: id, overlay: ctx.overlay ?? null, game });
    return { ...ctx, area: id };
  };
  const registry = {
    pick: { name: 'pick', run: (ctx, host) => import('@picker').then((m) => m.pickStep.run(ctx, host)) },   // loaded only when used: MapLibre is large
    build: buildStep,
    track: trackStep,
    race: { name: 'race', async run(ctx) {
      if (ctx.overlay?.type !== 'track') throw new FlowError('there is no track to race on: use ?flow=track,race (draw one first)');
      return finishFlow(ctx, 'racer');
    } },
    play: { name: 'play', run: (ctx) => finishFlow(ctx, 'walker') },
  };
  const names = parseFlow(params, Object.keys(registry));
  if (names[0] !== 'play') document.body.classList.add('flow');
  const ctl = new AbortController();
  await runFlow(names, registry, params.has('area') ? { area } : {}, () => { const root = $('flow'); root.hidden = false; root.innerHTML = ''; root.className = ''; return { root, signal: ctl.signal }; });
}

main().catch((e) => {
  document.body.classList.remove('flow'); $('flow').hidden = true;
  const text = e instanceof FlowError ? `Flow: ${e.message}` : `Error: ${e.message}`;
  $('credits').textContent = text; $('error').textContent = text; $('error').hidden = false;   // in the middle of the screen, not just the footer
  console.error(e);
});
