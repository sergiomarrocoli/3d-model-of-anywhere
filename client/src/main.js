import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBundle } from './bundle.js';
import { buildTerrain } from './terrain.js';
import { buildBuildings } from './buildings.js';
import { zRef } from './coords.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function main() {
  const areas = await (await fetch('/bundles/index.json')).json();
  if (!areas.length) throw new Error('no bundles found; run build_area.py first');
  const area = params.get('area') ?? areas[0];
  $('areas').innerHTML = areas.map((a) => `<a href="?area=${a}"${a === area ? ' class="on"' : ''}>${a}</a>`).join(' ') + ' <a href="?debug&area=' + area + '">debug</a>';
  if (params.has('debug')) { document.body.classList.add('debug'); return (await import('./debug.js')).debugMain(); }

  const bundle = await loadBundle(`/bundles/area_${area}`);
  const { meta, heightmap, imagery, buildings } = bundle;
  $('credits').textContent = meta.attribution.join(' · ');

  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);
  const terrain = buildTerrain(meta, heightmap, imagery, renderer);
  scene.add(terrain);
  scene.add(buildBuildings(meta, buildings, terrain.material.map)); // roofs share the terrain's imagery texture

  // Only the wall material is lit (the imagery already has baked shadows); #14 finalises lighting.
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
  sun.position.set(-200, 300, 150);
  scene.add(sun);

  // Temporary orbit camera so the terrain can be inspected; #14 replaces it with a free-fly camera.
  const [W, H] = meta.size_m;
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
  const centre = new THREE.Vector3(W / 2, 0, -H / 2);
  camera.position.set(W * 0.5, W * 0.75, W * 0.45);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(centre);
  controls.update();

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize); resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  window.__app = { THREE, scene, camera, renderer, controls, meta, zRef: zRef(meta) };
  document.title = `civil-war: ${meta.id}`;
}

main().catch((e) => { $('credits').textContent = `Error: ${e.message}`; console.error(e); });
