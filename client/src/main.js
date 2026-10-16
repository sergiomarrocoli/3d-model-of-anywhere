import * as THREE from 'three';
import { loadBundle } from './bundle.js';
import { buildTerrain } from './terrain.js';
import { buildBuildings } from './buildings.js';
import { createFlyCamera } from './flycam.js';
import { createGameCamera } from './gamecam.js';
import { sampleHeight } from './heightmap.js';
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

  // One directional "sun", no shadows (the imagery already has baked ones). Only walls are lit; roofs and
  // terrain are unlit imagery. A little ambient keeps shaded walls from going black.
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
  sun.position.set(-200, 300, 150);
  scene.add(sun);

  const [W, H] = meta.size_m;
  const ref = zRef(meta);
  const clock = new THREE.Clock();
  let camera, tick, setAspect = () => {};
  let player;
  if (params.has('fly')) {
    // Debug free-fly camera (?fly)
    camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
    const fly = createFlyCamera(camera, canvas, {
      position: new THREE.Vector3(W * 0.5, W * 0.45, -H * 0.5 + W * 0.45),
      lookAt: new THREE.Vector3(W / 2, 0, -H / 2),
      speed: W / 8,
    });
    tick = (dt) => fly.update(dt);
    setAspect = (a) => { camera.aspect = a; camera.updateProjectionMatrix(); };
  } else {
    // Game view: fixed angled ortho camera locked to the player (#15)
    const game = createGameCamera();
    camera = game.camera;
    player = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 12), new THREE.MeshLambertMaterial({ color: 0xe03030 }));
    const place = (x, y) => player.position.set(x, sampleHeight(heightmap, x, y) - ref + 0.9, -y);
    place(W / 2, H / 2);
    scene.add(player);
    tick = () => game.follow(player.position);
    setAspect = game.setAspect;
  }

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    setAspect(w / h);
  };
  addEventListener('resize', resize); resize();
  renderer.setAnimationLoop(() => { tick(Math.min(clock.getDelta(), 0.1)); renderer.render(scene, camera); });
  window.__app = { THREE, scene, camera, renderer, player, meta, zRef: zRef(meta) };
  document.title = `civil-war: ${meta.id}`;
}

main().catch((e) => { $('credits').textContent = `Error: ${e.message}`; console.error(e); });
