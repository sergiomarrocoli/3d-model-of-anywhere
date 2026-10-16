import * as THREE from 'three';
import { toWorld } from './coords.js';
import { sampleHeight } from './heightmap.js';

/**
 * One vertex per metre at integer local coordinates (0..size, so 501 x 501 for a 500 m box), displaced by the
 * bilinear heightmap. UVs map the imagery planarly: u = x / width, v = 1 - y / height (the imagery's top row is north).
 */
export function buildTerrainGeometry(meta, heightmap) {
  const [W, H] = meta.size_m;
  const step = heightmap.resolution;
  const nx = Math.round(W / step) + 1, ny = Math.round(H / step) + 1;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * step, y = j * step, k = j * nx + i;
      pos.set(toWorld(meta, x, y, sampleHeight(heightmap, x, y)), k * 3);
      uv.set([x / W, 1 - y / H], k * 2);
    }
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let t = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; // y grows north (-Z), so wind to face up
      idx.set([a, b, c, b, d, c], t); t += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

export function imageryTexture(imageBitmap, renderer) {
  const tex = new THREE.Texture(imageBitmap);
  tex.flipY = false; // ImageBitmap rows are top-down and the UVs above already account for it
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  tex.needsUpdate = true;
  return tex;
}

/** The imagery is baked with its own shadows, so it is shown unlit (lighting is a later story). */
export function buildTerrain(meta, heightmap, imagery, renderer) {
  const mesh = new THREE.Mesh(buildTerrainGeometry(meta, heightmap), new THREE.MeshBasicMaterial({ map: imageryTexture(imagery, renderer) }));
  mesh.name = 'terrain';
  return mesh;
}
