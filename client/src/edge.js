import * as THREE from 'three';

export const EDGE_FADE_M = 30;   // terrain fades to the background colour over this distance from the box edge
export const EDGE_MARGIN_M = 5;  // the player cannot get closer than this to the edge

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** 1 in the interior, 0 at the box edge (world X east 0..W, world Z -H..0). The GLSL in edgeFade mirrors this. */
export function edgeFactor(x, z, W, H, fade = EDGE_FADE_M) {
  return smoothstep(0, fade, Math.min(x, W - x, z + H, -z));
}

/** Keep a world-space position inside the box by `margin`. */
export function clampToBox(x, z, W, H, margin = EDGE_MARGIN_M) {
  return { x: Math.min(W - margin, Math.max(margin, x)), z: Math.min(-margin, Math.max(-H + margin, z)) };
}

/** Make a built-in material fade to `bg` toward the box edge, so the world ends in darkness, not a cliff. */
export function edgeFade(material, W, H, bg, fade = EDGE_FADE_M) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEdgeBox = { value: new THREE.Vector3(W, H, fade) };
    shader.uniforms.uEdgeColor = { value: new THREE.Vector3(bg.r, bg.g, bg.b) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEdgePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdgePos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEdgePos;\nuniform vec3 uEdgeBox;\nuniform vec3 uEdgeColor;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        float edgeD = min(min(vEdgePos.x, uEdgeBox.x - vEdgePos.x), min(vEdgePos.z + uEdgeBox.y, -vEdgePos.z));
        gl_FragColor.rgb = mix(uEdgeColor, gl_FragColor.rgb, smoothstep(0.0, uEdgeBox.z, edgeD));`);
  };
  material.customProgramCacheKey = () => 'edgefade';
  material.needsUpdate = true;
}
