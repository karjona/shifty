// Simple shapes put together into one mesh, each part in its own colour
// (vertex colours), so a model made of many boxes draws in one go.
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export class Parts {
  private geometries: THREE.BufferGeometry[] = [];

  /** Adds `geo` in `color`, turned by `(rx, ry, rz)` (radians, XYZ) and moved to `(x, y, z)`. */
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ),
    );
    const c = new THREE.Color(color);
    const n = g.attributes.position!.count;
    const colours = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colours.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "color") g.deleteAttribute(name);
    }
    this.geometries.push(g);
  }

  /** The parts as one mesh (with a material that takes their colours). */
  build(options: THREE.MeshStandardNodeMaterialParameters = {}): THREE.Mesh {
    const geo = mergeGeometries(this.geometries) ?? new THREE.BufferGeometry();
    for (const g of this.geometries) g.dispose();
    this.geometries = [];
    return new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, ...options }));
  }
}
