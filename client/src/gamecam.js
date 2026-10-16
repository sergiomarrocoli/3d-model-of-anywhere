import * as THREE from 'three';

export const TILT_DEG = 60;      // degrees above horizontal
export const VIEW_WIDTH_M = 150; // metres across the screen at the focus point (3x the original 50 m)
export const MIN_VIEW_M = 10, MAX_VIEW_M = 3000;
export const MIN_TILT_DEG = 20, MAX_TILT_DEG = 90;
const DISTANCE = 1500;           // far from the scene so the ortho near/far never clip it, even zoomed right out

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
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DISTANCE * 4);
  const state = { viewWidth, tiltDeg, aspect };
  let offset = cameraOffset(state.tiltDeg);
  const target = new THREE.Vector3();
  const place = () => { camera.position.copy(target).add(offset); };
  const orient = () => { // rotation depends only on the tilt, so it is only recomputed when the tilt changes
    offset = cameraOffset(state.tiltDeg);
    camera.position.copy(offset);
    camera.lookAt(0, 0, 0);
    place();
  };
  const refresh = () => {
    const { halfW, halfH } = frustum(state.aspect, state.viewWidth);
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
  };
  const setAspect = (a) => { state.aspect = a; refresh(); };
  /** factor > 1 zooms out, < 1 zooms in (multiplicative, so every wheel notch feels the same at any distance). */
  const zoomBy = (factor) => { state.viewWidth = Math.min(MAX_VIEW_M, Math.max(MIN_VIEW_M, state.viewWidth * factor)); refresh(); };
  const tiltBy = (deg) => { state.tiltDeg = Math.min(MAX_TILT_DEG, Math.max(MIN_TILT_DEG, state.tiltDeg + deg)); orient(); };
  const follow = (t) => { target.copy(t); place(); };
  orient(); refresh();
  return { camera, follow, setAspect, zoomBy, tiltBy, state };
}
