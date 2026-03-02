import * as THREE from "three";

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
  });

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  return renderer;
}
