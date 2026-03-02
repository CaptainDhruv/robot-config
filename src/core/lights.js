import * as THREE from "three";

export function addLights(scene) {
  // soft ambient base
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));

  // key light
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(5, 8, 5);
  scene.add(key);

  // fill light
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-5, 4, -5);
  scene.add(fill);
}
