import * as THREE from 'three';

export const TILT_DEG = 60;      // degrees above horizontal
export const VIEW_WIDTH_M = 50;  // metres across the screen at the focus point
const DISTANCE = 400;            // far from the scene so the ortho near/far never clip it

/** Offset from the target to the camera: due south and up, so north is always "up" the screen. */
export function cameraOffset(tiltDeg = TILT_DEG, distance = DISTANCE) {
  const t = (tiltDeg * Math.PI) / 180;
  return new THREE.Vector3(0, Math.sin(t) * distance, Math.cos(t) * distance);
}

/** Frustum half-extents for an ortho camera showing `viewWidth` metres across. */
export function frustum(aspect, viewWidth = VIEW_WIDTH_M) {
  return { halfW: viewWidth / 2, halfH: viewWidth / 2 / aspect };
}

/**
 * Fixed angled orthographic camera locked to a target. Rotation never changes; only the position follows.
 * Because it is tilted, the vertical extent is foreshortened: a ground span of s metres north-south
 * covers s * sin(tilt) metres of screen height.
 */
export function createGameCamera({ aspect = 1, viewWidth = VIEW_WIDTH_M, tiltDeg = TILT_DEG } = {}) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DISTANCE * 3);
  const offset = cameraOffset(tiltDeg);
  const state = { viewWidth };
  const setAspect = (a) => {
    const { halfW, halfH } = frustum(a, state.viewWidth);
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
  };
  camera.position.copy(offset);
  camera.lookAt(0, 0, 0); // rotation is set once and never touched again
  const follow = (target) => { camera.position.copy(target).add(offset); };
  setAspect(aspect);
  return { camera, follow, setAspect, state };
}
