import * as THREE from 'three';

const EULER = new THREE.Euler(0, 0, 0, 'YXZ');

/** Pure movement step: `keys` is a Set of key codes, returns the world-space displacement for `dt` seconds. */
export function flyDelta(keys, yaw, dt, speed) {
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const u = (keys.has('KeyE') || keys.has('Space') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
  const mult = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  const d = speed * mult * dt;
  // yaw 0 faces -Z (north); positive yaw turns left.
  return new THREE.Vector3(
    (-Math.sin(yaw) * f + Math.cos(yaw) * r) * d,
    u * d,
    (-Math.cos(yaw) * f - Math.sin(yaw) * r) * d,
  );
}

/** Free-fly debug camera: WASD move, Q/E (or Space) down/up, Shift = 4x, drag to look, wheel changes speed. */
export function createFlyCamera(camera, canvas, { position, lookAt, speed = 60 }) {
  camera.position.copy(position);
  camera.lookAt(lookAt);
  EULER.setFromQuaternion(camera.quaternion);
  let yaw = EULER.y, pitch = EULER.x;
  const keys = new Set();
  let dragging = false;

  const apply = () => { EULER.set(pitch, yaw, 0); camera.quaternion.setFromEuler(EULER); };
  addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey) keys.add(e.code); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= e.movementX * 0.003;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * 0.003));
    apply();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    speed = Math.max(2, Math.min(1000, speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  }, { passive: false });
  apply();

  return {
    update(dt) { camera.position.add(flyDelta(keys, yaw, dt, speed)); },
    get speed() { return speed; },
  };
}
