// Scenery that never moves, drawn in fewer batches: meshes that share a
// material (and lie near each other) become one mesh, placed once.
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export interface MergeOptions {
  /** Meshes are merged only with others in the same square cell this wide (m), so batches still cull. */
  cell?: number;
  /** Meshes with more vertices than this are left as they are (they are batches already). */
  maxVertices?: number;
}

/**
 * Merges the static meshes under `root` that share a material, shadow
 * flags, layers and vertex layout, cell by cell. Instanced, skinned and
 * mirrored meshes, and anything under an object marked `userData.noMerge`
 * (it moves, or is a batch of its own), are left alone.
 */
export function mergeStatic(root: THREE.Object3D, { cell = 160, maxVertices = 6000 }: MergeOptions = {}): void {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const batches = new Map<string, THREE.Mesh[]>();
  const centre = new THREE.Vector3();
  const visit = (o: THREE.Object3D) => {
    if (o.userData.noMerge === true || !o.visible) return;
    if (o instanceof THREE.Mesh && mergeable(o, maxVertices)) {
      const g: THREE.BufferGeometry = o.geometry;
      g.computeBoundingSphere();
      centre.copy(g.boundingSphere!.center).applyMatrix4(o.matrixWorld);
      const material: THREE.Material = o.material;
      const key = [
        material.uuid,
        o.castShadow,
        o.receiveShadow,
        o.renderOrder,
        o.layers.mask,
        o.frustumCulled,
        g.index ? "indexed" : "flat",
        Object.keys(g.attributes).toSorted().join(","),
        Math.floor(centre.x / cell),
        Math.floor(centre.z / cell),
      ].join("|");
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = []));
      batch.push(o);
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const first = meshes[0]!;
    const geometries = meshes.map((m) => m.geometry.clone().applyMatrix4(toRoot.clone().multiply(m.matrixWorld)));
    const merged = mergeGeometries(geometries);
    for (const g of geometries) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, first.material);
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    mesh.layers.mask = first.layers.mask;
    mesh.frustumCulled = first.frustumCulled;
    mesh.matrixAutoUpdate = false;
    for (const m of meshes) m.removeFromParent();
    root.add(mesh);
  }
}

function mergeable(o: THREE.Mesh, maxVertices: number): boolean {
  if (o instanceof THREE.InstancedMesh || o instanceof THREE.SkinnedMesh) return false;
  if (Array.isArray(o.material) || o.geometry.groups.length > 0) return false;
  if (Object.keys(o.geometry.morphAttributes).length > 0) return false;
  if ((o.geometry.attributes.position?.count ?? 0) > maxVertices) return false;
  // A mirrored transform would turn the faces inside out.
  return o.matrixWorld.determinant() > 0;
}
