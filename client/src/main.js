// The shell: pick an area, make the renderer, and plug the modules together.
//   modules/map       loads and draws an area, answers questions about it
//   modules/walker    the click-to-move game and its camera
//   modules/presence  friends in the same room see each other
import * as THREE from 'three';
import { createFlyCamera, debugMain, listMaps, loadMap } from '@map';
import { startPresence } from '@presence';
import { startWalker } from '@walker';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEFAULT_AREA = 'newtown';

async function main() {
  const areas = await listMaps();
  if (!areas.length) throw new Error('no bundles found; run build_area.py first');
  const area = params.get('area') ?? (areas.includes(DEFAULT_AREA) ? DEFAULT_AREA : areas[0]);
  $('areas').innerHTML = areas.map((a) => `<a href="?area=${a}"${a === area ? ' class="on"' : ''}>${a}</a>`).join(' ') + ' <a href="?debug&area=' + area + '">debug</a>';
  if (params.has('debug')) { document.body.classList.add('debug'); return debugMain(); }

  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const map = await loadMap(`/bundles/area_${area}`, { renderer });
  scene.add(map.object);
  $('credits').textContent = map.attribution.join(' · ');
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
  window.__app = { THREE, scene, camera, renderer, map, walker, presence, player: walker?.player, meta: map.meta }; // for console poking
  document.title = `civil-war: ${map.meta.id}`;
}

main().catch((e) => { $('credits').textContent = `Error: ${e.message}`; console.error(e); });
