import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

export function loadGLB(url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err),
    );
  });
}
