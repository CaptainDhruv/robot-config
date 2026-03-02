import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export function createControls(camera, domElement) {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.8, 0);
  return controls;
}
