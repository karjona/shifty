import * as THREE from "three/webgpu";

/** Frees the GPU memory of everything under `root` (geometry, materials, textures). */
export function disposeTree(root: THREE.Object3D): void {
  root.removeFromParent();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    const mats: unknown[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!(m instanceof THREE.Material)) continue;
      for (const v of Object.values(m) as unknown[]) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}
