import * as THREE from "three";

export const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);

camera.position.set(0, 2.5, 5);
